const { expect } = require('chai');
const hre = require('hardhat');
const { ethers, network, time } = hre;

const { buildOrder, buildMakerTraits } = require('./helpers/orderUtils');
const { ether, getEventArgs } = require('./helpers/utils');

describe('Bounty: NativeOrder undercollateralized resolver reward', function () {
    it('can route maker collateral into resolver reward after a third-party WETH top-up', async function () {
        const [deployer, maker, resolver] = await ethers.getSigners();

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
        const makerCollateral = ether('0.0001');
        const baseFee = 10_000_000_000n; // 10 gwei
        const rewardCap = 70000n * baseFee * 11n / 10n;
        const topUp = rewardCap - makerCollateral;

        expect(rewardCap).to.be.greaterThan(makerCollateral);
        expect(topUp).to.be.greaterThan(0n);

        const order = buildOrder({
            maker: maker.address,
            receiver: maker.address,
            makerAsset: await weth.getAddress(),
            takerAsset: await dai.getAddress(),
            makingAmount: makerCollateral,
            takingAmount: makerCollateral,
            makerTraits: buildMakerTraits({ expiry: expiration }),
        });

        const createReceipt = await (
            await factory.connect(maker).create(order, { value: makerCollateral })
        ).wait();
        const cloneAddress = getEventArgs(
            createReceipt,
            factory.interface,
            'NativeOrderCreated',
        )[2];

        // Simulate unsolicited WETH sent to the deterministic native-order clone.
        await weth.connect(resolver).deposit({ value: topUp });
        await weth.connect(resolver).transfer(cloneAddress, topUp);

        await time.increaseTo(expiration);
        await network.provider.send('hardhat_setNextBlockBaseFeePerGas', [
            '0x2540be400', // 10 gwei
        ]);

        const makerBefore = await ethers.provider.getBalance(maker.address);
        const cloneBefore = await weth.balanceOf(cloneAddress);
        const resolverBefore = await ethers.provider.getBalance(resolver.address);

        expect(cloneBefore).to.equal(rewardCap);

        const tx = await (
            await ethers.getContractAt('NativeOrderImpl', cloneAddress)
        ).connect(resolver).cancelExpiredOrderByResolver(order, rewardCap);

        await expect(tx).to.emit(
            await ethers.getContractAt('NativeOrderImpl', cloneAddress),
            'NativeOrderCancelledByResolver',
        );

        const receipt = await tx.wait();
        const gasCost = receipt.gasUsed * receipt.gasPrice;
        const makerAfter = await ethers.provider.getBalance(maker.address);
        const resolverAfter = await ethers.provider.getBalance(resolver.address);

        // The full reward is sourced from the clone balance; after the top-up,
        // the difference between reward and resolver contribution is maker collateral.
        expect(makerAfter - makerBefore).to.equal(0n);
        expect(resolverAfter - resolverBefore + gasCost).to.equal(rewardCap);
        expect(rewardCap - topUp).to.equal(makerCollateral);
    });
});
