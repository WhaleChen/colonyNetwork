/* globals artifacts */
import web3Utils from "web3-utils";
import { BN } from "bn.js";

import {
  MANAGER_PAYOUT,
  EVALUATOR_PAYOUT,
  WORKER_PAYOUT,
  MANAGER_RATING,
  WORKER_RATING,
  RATING_1_SALT,
  RATING_2_SALT,
  MANAGER_ROLE,
  WORKER_ROLE,
  SPECIFICATION_HASH
} from "./constants";
import { currentBlockTime, createSignatures, createSignaturesTrezor, web3GetAccounts } from "./test-helper";

const IColony = artifacts.require("IColony");
const ITokenLocking = artifacts.require("ITokenLocking");
const Token = artifacts.require("Token");

export async function makeTask({ colony, hash = SPECIFICATION_HASH, domainId = 1 }) {
  const { logs } = await colony.makeTask(hash, domainId);
  // Reading the ID out of the event triggered by our transaction will allow us to make multiple tasks in parallel in the future.
  return logs.filter(log => log.event === "TaskAdded")[0].args.id;
}

async function getSigsAndTransactionData({ colony, functionName, taskId, signers, sigTypes, args }) {
  const txData = await colony.contract.methods[functionName](...args).encodeABI();
  const sigsPromises = sigTypes.map((type, i) => {
    if (type === 0) {
      return createSignatures(colony, taskId, [signers[i]], 0, txData);
    }
    return createSignaturesTrezor(colony, taskId, [signers[i]], 0, txData);
  });
  const sigs = await Promise.all(sigsPromises);
  const sigV = sigs.map(sig => sig.sigV[0]);
  const sigR = sigs.map(sig => sig.sigR[0]);
  const sigS = sigs.map(sig => sig.sigS[0]);
  return { sigV, sigR, sigS, txData };
}

export async function executeSignedTaskChange({ colony, functionName, taskId, signers, sigTypes, args }) {
  const { sigV, sigR, sigS, txData } = await getSigsAndTransactionData({ colony, functionName, taskId, signers, sigTypes, args });
  return colony.executeTaskChange(sigV, sigR, sigS, sigTypes, 0, txData);
}

export async function executeSignedRoleAssignment({ colony, functionName, taskId, signers, sigTypes, args }) {
  const { sigV, sigR, sigS, txData } = await getSigsAndTransactionData({ colony, functionName, taskId, signers, sigTypes, args });
  return colony.executeTaskRoleAssignment(sigV, sigR, sigS, sigTypes, 0, txData);
}

export async function setupAssignedTask({ colonyNetwork, colony, dueDate, domain = 1, skill = 0, evaluator, worker }) {
  const accounts = await web3GetAccounts();
  const manager = accounts[0];
  evaluator = evaluator ? evaluator : accounts[1];
  worker = worker ? worker : accounts[2];
  
  const taskId = await makeTask({ colony, domainId: domain });
  // If the skill is not specified, default to the root global skill
  if (skill === 0) {
    const rootGlobalSkill = await colonyNetwork.getRootGlobalSkillId.call();
    if (rootGlobalSkill.toNumber() === 0) throw new Error("Meta Colony is not setup and therefore the root global skill does not exist");

    await executeSignedTaskChange({
      colony,
      functionName: "setTaskSkill",
      taskId,
      signers: [manager],
      sigTypes: [0],
      args: [taskId, rootGlobalSkill.toNumber()]
    });
  } else {
    await executeSignedTaskChange({
      colony,
      functionName: "setTaskSkill",
      taskId,
      signers: [manager],
      sigTypes: [0],
      args: [taskId, skill]
    });
  }

  let signers = manager === evaluator ? [manager] : [manager, evaluator];
  let sigTypes = Array.from({ length: signers.length }, () => 0);

  await executeSignedRoleAssignment({
    colony,
    taskId,
    functionName: "setTaskEvaluatorRole",
    signers,
    sigTypes,
    args: [taskId, evaluator]
  });

  signers = manager === worker ? [manager] : [manager, worker];
  sigTypes = Array.from({ length: signers.length }, () => 0);

  await executeSignedRoleAssignment({
    colony,
    taskId,
    functionName: "setTaskWorkerRole",
    signers,
    sigTypes,
    args: [taskId, worker]
  });

  let dueDateTimestamp = dueDate;
  if (!dueDateTimestamp) {
    dueDateTimestamp = await currentBlockTime();
  }

  await executeSignedTaskChange({
    colony,
    functionName: "setTaskDueDate",
    taskId,
    signers,
    sigTypes,
    args: [taskId, dueDateTimestamp]
  });
  return taskId;
}

export async function setupFundedTask({
  colonyNetwork,
  colony,
  token,
  dueDate,
  domain,
  skill,
  evaluator,
  worker,
  managerPayout = MANAGER_PAYOUT,
  evaluatorPayout = EVALUATOR_PAYOUT,
  workerPayout = WORKER_PAYOUT
}) {
  const accounts = await web3GetAccounts();
  const manager = accounts[0];
  let tokenAddress;
  evaluator = evaluator ? evaluator : accounts[1];
  worker = worker ? worker : accounts[2];

  if (token === undefined) {
    tokenAddress = await colony.getToken.call();
  } else {
    tokenAddress = token === 0x0 ? 0x0 : token.address;
  }
  const taskId = await setupAssignedTask({ colonyNetwork, colony, dueDate, domain, skill, evaluator, worker });
  const task = await colony.getTask.call(taskId);
  const potId = task[6].toNumber();
  const managerPayoutBN = new BN(managerPayout);
  const evaluatorPayoutBN = new BN(evaluatorPayout);
  const workerPayoutBN = new BN(workerPayout);
  const totalPayouts = managerPayoutBN.add(workerPayoutBN).add(evaluatorPayoutBN);
  await colony.moveFundsBetweenPots(1, potId, totalPayouts.toString(), tokenAddress);

  await executeSignedTaskChange({
    colony,
    functionName: "setTaskManagerPayout",
    taskId,
    signers: [manager],
    sigTypes: [0],
    args: [taskId, tokenAddress, managerPayout.toString()]
  });

  let signers = manager === evaluator ? [manager] : [manager, evaluator];
  let sigTypes = Array.from({ length: signers.length }, () => 0);

  await executeSignedTaskChange({
    colony,
    functionName: "setTaskEvaluatorPayout",
    taskId,
    signers,
    sigTypes,
    args: [taskId, tokenAddress, evaluatorPayout.toString()]
  });

  signers = manager === worker ? [manager] : [manager, worker];
  sigTypes = Array.from({ length: signers.length }, () => 0);

  await executeSignedTaskChange({
    colony,
    functionName: "setTaskWorkerPayout",
    taskId,
    signers,
    sigTypes,
    args: [taskId, tokenAddress, workerPayout.toString()]
  });
  return taskId;
}

export async function setupRatedTask({
  colonyNetwork,
  colony,
  token,
  dueDate,
  domain,
  skill,
  evaluator,
  worker,
  managerPayout = MANAGER_PAYOUT,
  evaluatorPayout = EVALUATOR_PAYOUT,
  workerPayout = WORKER_PAYOUT,
  managerRating = MANAGER_RATING,
  managerRatingSalt = RATING_1_SALT,
  workerRating = WORKER_RATING,
  workerRatingSalt = RATING_2_SALT
}) {
  const accounts = await web3GetAccounts();
  evaluator = evaluator ? evaluator : accounts[1];
  worker = worker ? worker : accounts[2];

  const taskId = await setupFundedTask({
    colonyNetwork,
    colony,
    token,
    dueDate,
    domain,
    skill,
    evaluator,
    worker,
    managerPayout,
    evaluatorPayout,
    workerPayout
  });
  const WORKER_RATING_SECRET = web3Utils.soliditySha3(workerRatingSalt, workerRating);
  const MANAGER_RATING_SECRET = web3Utils.soliditySha3(managerRatingSalt, managerRating);
  await colony.submitTaskWorkRating(taskId, WORKER_ROLE, WORKER_RATING_SECRET, { from: evaluator });
  await colony.submitTaskWorkRating(taskId, MANAGER_ROLE, MANAGER_RATING_SECRET, { from: worker });
  await colony.revealTaskWorkRating(taskId, WORKER_ROLE, workerRating, workerRatingSalt, { from: evaluator });
  await colony.revealTaskWorkRating(taskId, MANAGER_ROLE, managerRating, managerRatingSalt, { from: worker });
  return taskId;
}

export async function giveUserCLNYTokens(colonyNetwork, address, _amount) {
  const accounts = await web3GetAccounts();
  const manager = accounts[0];
  const metaColonyAddress = await colonyNetwork.getMetaColony();
  const metaColony = await IColony.at(metaColonyAddress);
  const clnyAddress = await metaColony.getToken.call();
  const clny = await Token.at(clnyAddress);
  const amount = new BN(_amount);
  const mainStartingBalance = await clny.balanceOf.call(manager);
  const targetStartingBalance = await clny.balanceOf.call(address);
  await metaColony.mintTokens(amount * 3);
  await metaColony.claimColonyFunds(clny.address);
  const taskId = await setupRatedTask({
    colonyNetwork,
    colony: metaColony,
    managerPayout: amount.mul(new BN("2")),
    evaluatorPayout: new BN("0"),
    workerPayout: new BN("0")
  });
  await metaColony.finalizeTask(taskId);
  await metaColony.claimPayout(taskId, 0, clny.address);

  let mainBalance = await clny.balanceOf.call(manager);
  await clny.transfer(
    0x0,
    mainBalance
      .sub(amount)
      .sub(mainStartingBalance)
      .toString()
  );
  await clny.transfer(address, amount.toString());
  mainBalance = await clny.balanceOf.call(manager);
  if (address !== manager) {
    await clny.transfer(0x0, mainBalance.sub(mainStartingBalance).toString());
  }
  const userBalance = await clny.balanceOf.call(address);
  assert.equal(targetStartingBalance.add(amount).toString(), userBalance.toString());
}

export async function giveUserCLNYTokensAndStake(colonyNetwork, address, _amount) {
  const metaColonyAddress = await colonyNetwork.getMetaColony.call();
  const metaColony = await IColony.at(metaColonyAddress);
  const clnyAddress = await metaColony.getToken.call();
  const clny = await Token.at(clnyAddress);

  await giveUserCLNYTokens(colonyNetwork, address, _amount);
  const tokenLockingAddress = await colonyNetwork.getTokenLocking();
  const tokenLocking = await ITokenLocking.at(tokenLockingAddress);
  await clny.approve(tokenLocking.address, _amount.toString(), { from: address });
  await tokenLocking.deposit(clny.address, _amount.toString(), { from: address });
}

export async function fundColonyWithTokens(colony, token, tokenAmount) {
  const colonyToken = await colony.getToken.call();
  if (colonyToken === token.address) {
    await colony.mintTokens(tokenAmount);
  } else {
    await token.mint(tokenAmount);
    await token.transfer(colony.address, tokenAmount);
  }
  await colony.claimColonyFunds(token.address);
}
