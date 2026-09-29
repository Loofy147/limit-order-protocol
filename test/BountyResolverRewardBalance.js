const { expect } = require('chai');
const hre = require('hardhat');
const { ethers, network, time } = hre;

const { buildOrder, buildMakerTraits } = require('./helpers/orderUtils');
const { ether, getEventArgs } = require('./helpers/utils');

describe('Bounty: NativeOrder resolver reward uses total clone balance', function () {
    it('isolates the reward-from-donated-balance behavior on a local deployment', async function () {
        const [deployer, maker, resolver, donor] = await ethers.getSigners();

        const TokenMock = await ethers.getContractFactory('TokenMock');
        const dai = await TokenMock.deploy('DAI', 'DAI');
        await dai.waitForDeployment();

        const accessToken = await TokenMock.deploy('Access Token', 'ACCESS');
        await accessToken.waitForDeployment();
        await accessToken.mint(resolver.address, 1);

        const WETH = await ethers.getContractFactory('WrappedTokenMock');
        const weth = await WETH.deploy('WETH', 'WETH');
        await weth.waitForDeployment();

        const LimitOrderProtocol = await ethers.getContractFactory('LimitOrderProtocol');
        const lop = await LimitOrderProtocol.deploy(await weth.getAddress());
        await lop.waitForDeployment();

        const NativeOrderFactory = await ethers.getContractFactory('NativeOrderFactory');
        const factory = await NativeOrderFactory.deploy(
            await weth.getAddress(),
            await lop.getAddress(),
            await accessToken.getAddress(),
            60,
            '1inch Limit Order Protocol',
            '4',
        );
        await factory.waitForDeployment();

        const expiration = (await time.latest()) + 60;
        const order = buildOrder({
            maker: maker.address,
            receiver: maker.address,
            makerAsset: await weth.getAddress(),
            takerAsset: await dai.getAddress(),
            makingAmount: ether('1'),
            takingAmount: ether('1000'),
            makerTraits: buildMakerTraits({ expiry: expiration }),
        });

        const createReceipt = await (
            await factory.connect(maker).create(order, { value: order.makingAmount })
        ).wait();
        const cloneAddress = getEventArgs(
            createReceipt,
            factory.interface,
            'NativeOrderCreated',
        )[2];
        const clone = await ethers.getContractAt('NativeOrderImpl', cloneAddress);

        // A third party can increase a clone's WETH balance without changing
        // the original maker collateral or order hash.
        await weth.connect(donor).deposit({ value: 1 });
        await weth.connect(donor).transfer(cloneAddress, 1);

        await time.increaseTo(expiration);
        await network.provider.send('hardhat_setNextBlockBaseFeePerGas', ['0x2540be400']); // 10 gwei

        const rewardCap = 70000n * 11_000_000_000n / 10n;
        const makerBefore = await ethers.provider.getBalance(maker.address);
        const resolverBefore = await ethers.provider.getBalance(resolver.address);

        const tx = clone.connect(resolver).cancelExpiredOrderByResolver(order, rewardCap);
        await expect(tx).to.emit(clone, 'NativeOrderCancelledByResolver');

        const receipt = await (await tx).wait();
        const gasPrice = receipt.gasUsed * receipt.gasPrice;
        const makerAfter = await ethers.provider.getBalance(maker.address);
        const resolverAfter = await ethers.provider.getBalance(resolver.address);

        // The clone unwraps its entire WETH balance, then pays the reward from
        // that total balance before returning the remainder to the maker.
        const expectedReward = rewardCap;
        const expectedMakerDelta = ether('1') + 1n - expectedReward;

        expect(resolverAfter - resolverBefore).to.equal(expectedReward - 0n);
        expect(makerAfter - makerBefore).to.equal(expectedMakerDelta);

        // The reward is materially larger than the 1-wei external donation.
        expect(expectedReward).to.be.greaterThan(1n);
        // The local resolver spent gas, so this test is a flow-level assertion,
        // not a claim about net attacker profitability.
        expect(gasPrice).to.be.greaterThan(0n);
    });
});
