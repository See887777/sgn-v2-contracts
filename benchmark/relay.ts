import '@nomicfoundation/hardhat-ethers';

import { parseUnits, solidityPackedKeccak256, toNumber, Wallet } from 'ethers';
import fs from 'fs';
import { ethers } from 'hardhat';
import path from 'path';

import { HardhatEthersSigner } from '@nomicfoundation/hardhat-ethers/signers';
import { loadFixture } from '@nomicfoundation/hardhat-toolbox/network-helpers';

import { deployBridgeContracts, getAccounts } from '../test/lib/common';
import { getRelayRequest } from '../test/lib/proto';
import { Bridge, TestERC20 } from '../typechain';

const GAS_USAGE_DIR = 'reports/gas_usage/';
const GAS_USAGE_LOG = path.join(GAS_USAGE_DIR, 'relay.txt');

describe('Relay Gas Benchmark', function () {
  if (!fs.existsSync(GAS_USAGE_DIR)) {
    fs.mkdirSync(GAS_USAGE_DIR, { recursive: true });
  }
  fs.rmSync(GAS_USAGE_LOG, { force: true });
  fs.appendFileSync(GAS_USAGE_LOG, '<validatorNum, quorumSigNum, gasCost> for cbr testErc20 relay tx\n\n');

  async function fixture() {
    const [admin] = await ethers.getSigners();
    const { bridge, token } = await deployBridgeContracts(admin);
    return { admin, bridge, token };
  }

  let bridge: Bridge;
  let token: TestERC20;
  let admin: HardhatEthersSigner;
  let accounts: Wallet[];

  beforeEach(async () => {
    const res = await loadFixture(fixture);
    bridge = res.bridge;
    token = res.token;
    admin = res.admin;
    accounts = await getAccounts(admin, [token], 21);
    await token.transfer(bridge.getAddress(), parseUnits('1000000'));
    await bridge.setEpochVolumeCaps([token.getAddress()], [parseUnits('100')]);
    await bridge.setEpochLength(5);
    await bridge.setDelayThresholds([token.getAddress()], [parseUnits('100')]);
  });

  it('benchmark relay gas cost for bridge', async function () {
    let perSigCost;
    for (let i = 5; i <= 21; i += 2) {
      perSigCost = await doBenchmarkRelaySig(i);
    }
    fs.appendFileSync(GAS_USAGE_LOG, 'per sig cost: ' + perSigCost + '\n');
    fs.appendFileSync(GAS_USAGE_LOG, '\n');

    const perSignerCost = await doBenchmarkRelaySigner(21, 8);
    fs.appendFileSync(GAS_USAGE_LOG, 'per validator cost: ' + perSignerCost + '\n');
  });

  async function getPowers(
    accounts: Wallet[],
    signerNum: number,
    quorumSigNum: number
  ): Promise<{ signers: Wallet[]; addrs: string[]; powers: bigint[] }> {
    const signers: Wallet[] = [];
    const addrs: string[] = [];
    const powers: bigint[] = [];
    for (let i = 0; i < signerNum; i++) {
      signers.push(accounts[i]);
      addrs.push(accounts[i].address);
      if (i == quorumSigNum - 1) {
        powers.push(parseUnits('100'));
      } else {
        powers.push(parseUnits('1'));
      }
    }
    return { signers, addrs, powers };
  }

  async function doBenchmarkRelaySig(signerNum: number) {
    let firstCost = 0;
    let lastCost = 0;
    const maxQuorumSigNum = ((signerNum * 2) / 3 + 1) | 0;
    for (let i = 3; i <= maxQuorumSigNum; i += 2) {
      const gasUsed = await doBenchmarkRelay(signerNum, i);
      if (i == 3) {
        firstCost = toNumber(gasUsed);
      }
      lastCost = toNumber(gasUsed);
    }
    const perSigCost = Math.ceil((lastCost - firstCost) / (maxQuorumSigNum - 3));
    return perSigCost;
  }

  async function doBenchmarkRelaySigner(maxSignerNum: number, quorumSigNum: number) {
    let firstCost = 0;
    let lastCost = 0;
    const minSignerNum = ((quorumSigNum * 3) / 2) | 0;
    for (let i = minSignerNum; i <= maxSignerNum; i++) {
      const gasUsed = await doBenchmarkRelay(i, quorumSigNum);
      if (i == minSignerNum) {
        firstCost = toNumber(gasUsed);
      }
      lastCost = toNumber(gasUsed);
    }
    const perSignerCost = Math.ceil((lastCost - firstCost) / (maxSignerNum - minSignerNum));
    return perSignerCost;
  }

  async function doBenchmarkRelay(signerNum: number, quorumSigNum: number) {
    if (quorumSigNum > signerNum) {
      quorumSigNum = signerNum;
    }
    const { signers, addrs, powers } = await getPowers(accounts, signerNum, quorumSigNum);
    await bridge.notifyResetSigners();
    await bridge.resetSigners(addrs, powers);

    const sender = accounts[0];
    const receiver = accounts[1];
    const amount = parseUnits('1');
    const chainId = toNumber((await ethers.provider.getNetwork()).chainId);
    const srcXferId = solidityPackedKeccak256(['uint64'], [Date.now()]); // fake src xfer id
    const { relayBytes, sigs } = await getRelayRequest(
      sender.address,
      receiver.address,
      await token.getAddress(),
      amount,
      chainId,
      chainId,
      srcXferId,
      signers,
      await bridge.getAddress()
    );
    const gasUsed = (await (await bridge.relay(relayBytes, sigs, addrs, powers)).wait())!.gasUsed;
    fs.appendFileSync(GAS_USAGE_LOG, signerNum.toString() + '\t' + quorumSigNum.toString() + '\t' + gasUsed + '\n');
    return gasUsed;
  }
});
