const { expect } = require('chai');
const hre = require('hardhat');
const { ethers, network } = hre;

const { buildOrder, buildMakerTraits } = require('./helpers/orderUtils');
const { ether, getEventArgs } = require('./helpers/utils');

describe('Bounty: NativeOrder resolver reward economic calibration', function () {
    it('measures the profitable edge just below the reward cap at 10 gwei', async function () {
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

        const latestBlock = await ethers.provider.getBlock('latest');
        const expiration = latestBlock.timestamp + 60;
        const cancellationDelay = 60;

        const baseFee = 10_000_000_000n;
        await network.provider.send('hardhat_setNextBlockBaseFeePerGas', [
            '0x2540be400', // 10 gwei
        ]);

        const rewardCap = 70000n * baseFee * 11n / 10n;
        const makerCollateral = ether('0.0007');
        const topUp = rewardCap - makerCollateral;

        expect(topUp).to.equal(ether('0.00007'));

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

        await weth.connect(resolver).deposit({ value: topUp });
        await weth.connect(resolver).transfer(cloneAddress, topUp);

        await network.provider.send('evm_increaseTime', [60 + cancellationDelay + 1]);
        await network.provider.send('evm_mine');

        const makerBefore = await ethers.provider.getBalance(maker.address);
        const resolverBefore = await ethers.provider.getBalance(resolver.address);

        const tx = await (
            await ethers.getContractAt('NativeOrderImpl', cloneAddress)
        ).connect(resolver).cancelExpiredOrderByResolver(order, rewardCap);

        const receipt = await tx.wait();
        const gasCost = receipt.gasUsed * receipt.gasPrice;
        const makerAfter = await ethers.provider.getBalance(maker.address);
        const resolverAfter = await ethers.provider.getBalance(resolver.address);

        // The maker's entire residual clone collateral is consumed by the reward.
        const cancellationLoss = makerCollateral - (makerAfter - makerBefore);
        const resolverNetAfterTopUpAndGas = resolverAfter - resolverBefore;

        expect(makerAfter - makerBefore).to.equal(0n);
        expect(cancellationLoss).to.equal(makerCollateral);

        // Resolver economic identity:
        // reward - top-up - gas = C - gas.
        expect(
            resolverNetAfterTopUpAndGas + gasCost,
        ).to.equal(rewardCap - topUp);
        expect(resolverNetAfterTopUpAndGas).to.be.greaterThan(0n);

        console.log('ECONOMIC_CALIBRATION', JSON.stringify({
            makerCollateral: makerCollateral.toString(),
            rewardCap: rewardCap.toString(),
            topUp: topUp.toString(),
            gasUsed: receipt.gasUsed.toString(),
            gasPrice: receipt.gasPrice.toString(),
            gasCost: gasCost.toString(),
            victimCancellationLoss: cancellationLoss.toString(),
            resolverNetAfterTopUpAndGas: resolverNetAfterTopUpAndGas.toString(),
        }));
    });
});
