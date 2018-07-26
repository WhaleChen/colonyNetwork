/* globals artifacts */
import { getTokenArgs, web3GetNetwork, web3GetBalance, checkErrorRevert, checkErrorNonPayableFunction, expectEvent } from "../helpers/test-helper";

import { setupColonyVersionResolver } from "../helpers/upgradable-contracts";

const namehash = require("eth-ens-namehash");
const web3utils = require("web3-utils");

const ENSRegistry = artifacts.require("ENSRegistry");
const EtherRouter = artifacts.require("EtherRouter");
const Colony = artifacts.require("Colony");
const Token = artifacts.require("Token");
const ColonyFunding = artifacts.require("ColonyFunding");
const ColonyTask = artifacts.require("ColonyTask");
const IColonyNetwork = artifacts.require("IColonyNetwork");
const Resolver = artifacts.require("Resolver");

contract("ColonyNetwork", accounts => {
  const TOKEN_ARGS = getTokenArgs();
  const OTHER_ACCOUNT = accounts[1];
  let colonyFunding;
  let colonyTask;
  let resolver;
  let resolverColonyNetworkDeployed;
  let colonyNetwork;
  let createColonyGas;
  let version;

  before(async () => {
    const network = await web3GetNetwork();
    createColonyGas = network === "coverage" ? "0xfffffffffff" : 4e6;
    resolverColonyNetworkDeployed = await Resolver.deployed();
  });

  beforeEach(async () => {
    const colony = await Colony.new();
    version = await colony.version.call();
    resolver = await Resolver.new();
    colonyFunding = await ColonyFunding.new();
    colonyTask = await ColonyTask.new();

    const etherRouter = await EtherRouter.new();
    await etherRouter.setResolver(resolverColonyNetworkDeployed.address);
    colonyNetwork = await IColonyNetwork.at(etherRouter.address);
    await setupColonyVersionResolver(colony, colonyFunding, colonyTask, resolver, colonyNetwork);
  });

  describe("when initialised", () => {
    it("should accept ether", async () => {
      await colonyNetwork.send(1);
      const colonyNetworkBalance = await web3GetBalance(colonyNetwork.address);
      assert.equal(colonyNetworkBalance.toNumber(), 1);
    });

    it("should have the correct current Colony version set", async () => {
      const currentColonyVersion = await colonyNetwork.getCurrentColonyVersion.call();
      assert.equal(version.toNumber(), currentColonyVersion.toNumber());
    });

    it("should have the Resolver for current Colony version set", async () => {
      const currentResolver = await colonyNetwork.getColonyVersionResolver.call(version.toNumber());
      assert.equal(currentResolver, resolver.address);
    });

    it("should be able to register a higher Colony contract version", async () => {
      const sampleResolver = "0x65a760e7441cf435086ae45e14a0c8fc1080f54c";
      const currentColonyVersion = await colonyNetwork.getCurrentColonyVersion.call();
      const updatedVersion = currentColonyVersion.add(1).toNumber();
      await colonyNetwork.addColonyVersion(updatedVersion, sampleResolver);

      const updatedColonyVersion = await colonyNetwork.getCurrentColonyVersion.call();
      assert.equal(updatedColonyVersion.toNumber(), updatedVersion);
      const currentResolver = await colonyNetwork.getColonyVersionResolver.call(updatedVersion);
      assert.equal(currentResolver, sampleResolver);
    });

    it("when registering a lower version of the Colony contract, should NOT update the current (latest) colony version", async () => {
      const sampleResolver = "0x65a760e7441cf435086ae45e14a0c8fc1080f54c";
      const currentColonyVersion = await colonyNetwork.getCurrentColonyVersion.call();
      await colonyNetwork.addColonyVersion(currentColonyVersion.sub(1).toNumber(), sampleResolver);

      const updatedColonyVersion = await colonyNetwork.getCurrentColonyVersion.call();
      assert.equal(updatedColonyVersion.toNumber(), currentColonyVersion.toNumber());
    });
  });

  describe("when creating new colonies", () => {
    it("should allow users to create new colonies", async () => {
      const token = await Token.new(...TOKEN_ARGS);
      const { logs } = await colonyNetwork.createColony(token.address);
      const { colonyAddress } = logs[0].args;
      const colonyCount = await colonyNetwork.getColonyCount.call();
      assert.notEqual(colonyAddress, 0x0);
      assert.equal(colonyCount.toNumber(), 1);
    });

    it("should maintain correct count of colonies", async () => {
      const token = await Token.new(...getTokenArgs());
      await colonyNetwork.createColony(token.address);
      await colonyNetwork.createColony(token.address);
      await colonyNetwork.createColony(token.address);
      await colonyNetwork.createColony(token.address);
      await colonyNetwork.createColony(token.address);
      await colonyNetwork.createColony(token.address);
      await colonyNetwork.createColony(token.address);
      const colonyCount = await colonyNetwork.getColonyCount.call();
      assert.equal(colonyCount.toNumber(), 7);
    });

    it("when meta colony is created, should have the root global and local skills initialised, plus the local mining skill", async () => {
      const token = await Token.new(...TOKEN_ARGS);
      await colonyNetwork.createMetaColony(token.address);
      const skillCount = await colonyNetwork.getSkillCount.call();
      assert.equal(skillCount.toNumber(), 3);
      const rootGlobalSkill = await colonyNetwork.getSkill.call(1);
      assert.equal(rootGlobalSkill[0].toNumber(), 0);
      assert.equal(rootGlobalSkill[1].toNumber(), 0);

      const globalSkill1 = await colonyNetwork.getSkill.call(1);
      assert.isTrue(globalSkill1[2]);

      const globalSkill2 = await colonyNetwork.getSkill.call(2);
      assert.isFalse(globalSkill2[2]);

      const localSkill1 = await colonyNetwork.getSkill.call(3);
      assert.isFalse(localSkill1[2]);

      const rootGlobalSkillId = await colonyNetwork.getRootGlobalSkillId.call();
      assert.equal(rootGlobalSkillId, 1);
    });

    it("should fail to create meta colony if it already exists", async () => {
      const token = await Token.new(...TOKEN_ARGS);
      await colonyNetwork.createMetaColony(token.address);
      const metaColonyAddress1 = await colonyNetwork.getMetaColony.call();

      await checkErrorRevert(colonyNetwork.createMetaColony(token.address));
      const metaColonyAddress2 = await colonyNetwork.getMetaColony.call();
      assert.equal(metaColonyAddress1, metaColonyAddress2);
    });

    it("when any colony is created, should have the root local skill initialised", async () => {
      const token = await Token.new(...TOKEN_ARGS);
      const { logs } = await colonyNetwork.createColony(token.address);
      const rootLocalSkill = await colonyNetwork.getSkill.call(1);
      assert.equal(rootLocalSkill[0].toNumber(), 0);
      assert.equal(rootLocalSkill[1].toNumber(), 0);

      const skill = await colonyNetwork.getSkill.call(2);
      assert.isFalse(skill[2]);

      const { colonyAddress } = logs[0].args;
      const colony = await Colony.at(colonyAddress);
      const rootDomain = await colony.getDomain.call(1);
      assert.equal(rootDomain[0].toNumber(), 1);
      assert.equal(rootDomain[1].toNumber(), 1);

      const domainCount = await colony.getDomainCount.call();
      assert.equal(domainCount.toNumber(), 1);
    });

    it("should fail if ETH is sent", async () => {
      try {
        const token = await Token.new(...TOKEN_ARGS);
        await colonyNetwork.createColony(token.address, { value: 1, gas: createColonyGas });
      } catch (err) {
        checkErrorNonPayableFunction(err);
      }
      const colonyNetworkBalance = await web3GetBalance(colonyNetwork.address);
      assert.equal(0, colonyNetworkBalance.toNumber());
    });

    it("should log a ColonyAdded event", async () => {
      const token = await Token.new(...TOKEN_ARGS);
      await expectEvent(colonyNetwork.createColony(token.address), "ColonyAdded");
    });
  });

  describe("when getting existing colonies", () => {
    it("should allow users to get the address of a colony by its index", async () => {
      const token = await Token.new(...TOKEN_ARGS);
      await colonyNetwork.createColony(token.address);
      await colonyNetwork.createColony(token.address);
      await colonyNetwork.createColony(token.address);
      const colonyAddress = await colonyNetwork.getColony.call(3);
      assert.notEqual(colonyAddress, "0x0000000000000000000000000000000000000000");
    });

    it("should return an empty address if there is no colony for the index provided", async () => {
      const colonyAddress = await colonyNetwork.getColony.call(15);
      assert.equal(colonyAddress, "0x0000000000000000000000000000000000000000");
    });

    it("should be able to get the Colony version", async () => {
      const token = await Token.new(...TOKEN_ARGS);
      const { logs } = await colonyNetwork.createColony(token.address);
      const { colonyAddress } = logs[0].args;
      const colony = await Colony.at(colonyAddress);
      const actualColonyVersion = await colony.version.call();
      assert.equal(version.toNumber(), actualColonyVersion.toNumber());
    });
  });

  describe("when upgrading a colony", () => {
    it("should be able to upgrade a colony, if a sender has owner role", async () => {
      const token = await Token.new(...TOKEN_ARGS);
      const { logs } = await colonyNetwork.createColony(token.address);
      const { colonyAddress } = logs[0].args;
      const colonyEtherRouter = await EtherRouter.at(colonyAddress);
      const colony = await Colony.at(colonyAddress);

      const sampleResolver = "0x65a760e7441cf435086ae45e14a0c8fc1080f54c";
      const currentColonyVersion = await colonyNetwork.getCurrentColonyVersion.call();
      const newVersion = currentColonyVersion.add(1).toNumber();
      await colonyNetwork.addColonyVersion(newVersion, sampleResolver);

      await colony.upgrade(newVersion);
      const colonyResolver = await colonyEtherRouter.resolver.call();
      assert.equal(colonyResolver, sampleResolver);
    });

    it("should not be able to set colony resolver by directly calling `setResolver`", async () => {
      const token = await Token.new(...TOKEN_ARGS);
      const { logs } = await colonyNetwork.createColony(token.address);
      const { colonyAddress } = logs[0].args;
      const colony = await EtherRouter.at(colonyAddress);

      const sampleResolver = "0x65a760e7441cf435086ae45e14a0c8fc1080f54c";
      const currentColonyVersion = await colonyNetwork.getCurrentColonyVersion.call();
      const newVersion = currentColonyVersion.add(1).toNumber();
      await colonyNetwork.addColonyVersion(newVersion, sampleResolver);

      await checkErrorRevert(await EtherRouter.at(colony.address).setResolver(sampleResolver));
    });

    it("should NOT be able to upgrade a colony to a lower version", async () => {
      const token = await Token.new(...TOKEN_ARGS);
      const { logs } = await colonyNetwork.createColony(token.address);
      const { colonyAddress } = logs[0].args;
      const colony = await Colony.at(colonyAddress);

      const sampleResolver = "0x65a760e7441cf435086ae45e14a0c8fc1080f54c";
      const currentColonyVersion = await colonyNetwork.getCurrentColonyVersion.call();
      const newVersion = currentColonyVersion.sub(1).toNumber();
      await colonyNetwork.addColonyVersion(newVersion, sampleResolver);

      await checkErrorRevert(colony.upgrade(newVersion));
      assert.equal(version.toNumber(), currentColonyVersion.toNumber());
    });

    it("should NOT be able to upgrade a colony to a nonexistent version", async () => {
      const token = await Token.new(...TOKEN_ARGS);
      const { logs } = await colonyNetwork.createColony(token.address);
      const { colonyAddress } = logs[0].args;
      const currentColonyVersion = await colonyNetwork.getCurrentColonyVersion.call();
      const newVersion = currentColonyVersion.add(1).toNumber();
      const colony = await Colony.at(colonyAddress);

      await checkErrorRevert(colony.upgrade(newVersion));
      assert.equal(version.toNumber(), currentColonyVersion.toNumber());
    });

    it("should NOT be able to upgrade a colony if sender don't have owner role", async () => {
      const token = await Token.new(...TOKEN_ARGS);
      const { logs } = await colonyNetwork.createColony(token.address);
      const { colonyAddress } = logs[0].args;
      const colonyEtherRouter = await EtherRouter.at(colonyAddress);
      const colonyResolver = await colonyEtherRouter.resolver.call();
      const colony = await Colony.at(colonyAddress);

      const sampleResolver = "0x65a760e7441cf435086ae45e14a0c8fc1080f54c";
      const currentColonyVersion = await colonyNetwork.getCurrentColonyVersion.call();
      const newVersion = currentColonyVersion.add(1).toNumber();
      await colonyNetwork.addColonyVersion(newVersion, sampleResolver);

      await checkErrorRevert(colony.upgrade(newVersion, { from: OTHER_ACCOUNT }));
      assert.notEqual(colonyResolver, sampleResolver);
    });
  });

  describe("when adding a skill", () => {
    beforeEach(async () => {
      const token = await Token.new(...TOKEN_ARGS);
      const { logs } = await colonyNetwork.createColony(token.address);
      const { colonyAddress } = logs[0].args;
      await token.setOwner(colonyAddress);
    });

    it("should not be able to add a global skill, by an address that is not the meta colony ", async () => {
      await checkErrorRevert(colonyNetwork.addSkill(1, true));
      const skillCount = await colonyNetwork.getSkillCount.call();
      assert.equal(skillCount.toNumber(), 1);
    });

    it("should NOT be able to add a local skill, by an address that is not a Colony", async () => {
      await checkErrorRevert(colonyNetwork.addSkill(2, false));

      const skillCount = await colonyNetwork.getSkillCount.call();
      assert.equal(skillCount.toNumber(), 1);
    });
  });

  describe("when managing ENS names", () => {
    const rootNode = namehash.hash("joincolony.eth");
    let ensRegistry;

    beforeEach(async () => {
      ensRegistry = await ENSRegistry.new();
      await ensRegistry.setOwner(rootNode, colonyNetwork.address);
      await colonyNetwork.setupRegistrar(ensRegistry.address, rootNode);
    });

    it("should own the root domains", async () => {
      let owner;
      owner = await ensRegistry.owner(rootNode);
      assert.equal(owner, colonyNetwork.address);

      owner = await ensRegistry.owner(namehash.hash("user.joincolony.eth"));
      assert.equal(owner, colonyNetwork.address);

      owner = await ensRegistry.owner(namehash.hash("colony.joincolony.eth"));
      assert.equal(owner, colonyNetwork.address);
    });

    it("should be able to register one unique label per user", async () => {
      const label = web3utils.soliditySha3("test");
      const hash = namehash.hash("test.user.joincolony.eth");

      // User can register unique label
      await colonyNetwork.registerUserLabel(label, { from: accounts[1] });
      const owner = await ensRegistry.owner(hash);
      assert.equal(owner, accounts[1]);

      // Label already in use
      await checkErrorRevert(colonyNetwork.registerUserLabel(label, { from: accounts[2] }));

      // Can't register two labels for a user
      const newLabel = web3utils.soliditySha3("test2");
      await checkErrorRevert(colonyNetwork.registerUserLabel(newLabel, { from: accounts[1] }));
    });

    it("should be able to register one unique label per colony, if owner", async () => {
      const label = web3utils.soliditySha3("test");
      const hash = namehash.hash("test.colony.joincolony.eth");

      // Cargo-cult colony generation
      const token = await Token.new(...TOKEN_ARGS);
      const { logs } = await colonyNetwork.createColony(token.address);
      const { colonyAddress } = logs[0].args;
      const colony = await Colony.at(colonyAddress);

      // Non-owner can't register label for colony
      await checkErrorRevert(colony.registerColonyLabel(label, { from: accounts[1] }));

      // Owner can register label for colony
      await colony.registerColonyLabel(label, { from: accounts[0] });
      const owner = await ensRegistry.owner(hash);
      assert.equal(owner, colony.address);

      // Can't register two labels for a colony
      const newLabel = web3utils.soliditySha3("test2");
      await checkErrorRevert(colony.registerColonyLabel(newLabel, { from: accounts[0] }));
    });
  });
});
