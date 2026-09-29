const { expect } = require('chai');
const hre = require('hardhat');
const { ethers, network } = hre;

const {
    ABIOrder,
    buildOrder,
    buildTakerTraits,
} = require('./helpers/orderUtils');
const { ether, getEventArgs } = require('./helpers/utils');
const { deploySwapTokens } = require('./helpers/fixtures');

describe('Bounty: NativeOrder resolver reward partial-fill edge', function () {
    it('captures a naturally created residual below the reward cap after partial fill', async function () {
        const [taker, maker, resolver] = await ethers.getSigners();
        const { dai, weth, swap } = await deploySwapTokens();

        const TokenMock = await ethers.getContractFactory('TokenMock');
        const accessToken = await TokenMock.deploy('Access Token', 'ACCESS');
        await accessToken.waitForDeployment();
        await accessToken.mint(resolver.address, 1);

        // Mirror the upstream ETH-maker fixture: both maker and taker are funded,
        // and both accounts have the LOP allowance established.
        await dai.mint(maker.address, ether('10'));
        await dai.mint(taker.address, ether('10'));
        await dai.connect(maker).approve(await swap.getAddress(), ether('10'));
        await dai.connect(taker).approve(await swap.getAddress(), ether('10'));

        const NativeOrderFactory = await ethers.getContractFactory('NativeOrderFactory');
        const factory = await NativeOrderFactory.deploy(
            await weth.getAddress(),
            await swap.getAddress(),
            await accessToken.getAddress(),
            60,
            '1inch Limit Order Protocol',
            '4',
        );
        await factory.waitForDeployment();

        const latestBlock = await ethers.provider.getBlock('latest');
        const expiration = latestBlock.timestamp + 60;

        const initialMakingAmount = ether('0.0014');
        const initialTakingAmount = ether('1.4');
        const partialTakingAmount = ether('0.7');
        const residualCollateral = ether('0.0007');
        const baseFee = 10_000_000_000n;
        const rewardCap = 70000n * baseFee * 11n / 10n;
        const topUp = rewardCap - residualCollateral;

        expect(topUp).to.equal(ether('0.00007'));

        const originalOrder = buildOrder(
            {
                maker: maker.address,
                receiver: maker.address,
                makerAsset: await weth.getAddress(),
                takerAsset: await dai.getAddress(),
                makingAmount: initialMakingAmount,
                takingAmount: initialTakingAmount,
            },
            {},
        );

        const createReceipt = await (
            await factory.connect(maker).create(originalOrder, { value: initialMakingAmount })
        ).wait();
        const cloneAddress = getEventArgs(
            createReceipt,
            factory.interface,
            'NativeOrderCreated',
        )[2];

        expect(await weth.balanceOf(cloneAddress)).to.equal(initialMakingAmount);

        expect(await dai.balanceOf(taker.address)).to.be.greaterThanOrEqual(partialTakingAmount);
        expect(
            await dai.allowance(taker.address, await swap.getAddress()),
        ).to.be.greaterThanOrEqual(partialTakingAmount);

        const makerDaiBeforeFill = await dai.balanceOf(maker.address);

        const signature = ethers.AbiCoder.defaultAbiCoder().encode(
            [ABIOrder],
            [originalOrder],
        );
        const fillOrder = { ...originalOrder, maker: cloneAddress };
        const takerTraits = buildTakerTraits({
            // threshold is the minimum accepted making amount (WETH),
            // while fillContractOrderArgs receives the taking amount (DAI).
            threshold: residualCollateral,
            extension: originalOrder.extension,
        });

        await (await swap.fillContractOrderArgs(
            fillOrder,
            signature,
            partialTakingAmount,
            takerTraits.traits,
            takerTraits.args,
        )).wait();

        expect(await weth.balanceOf(cloneAddress)).to.equal(residualCollateral);
        expect(await dai.balanceOf(maker.address) - makerDaiBeforeFill).to.equal(partialTakingAmount);

        await network.provider.send('evm_increaseTime', [61 + 60 + 1]);
        await network.provider.send('evm_mine');

        const resolverBefore = await ethers.provider.getBalance(resolver.address);

        const depositTx = await weth.connect(resolver).deposit({ value: topUp });
        const depositReceipt = await depositTx.wait();

        const transferTx = await weth.connect(resolver).transfer(cloneAddress, topUp);
        const transferReceipt = await transferTx.wait();

        // Pin the base fee on the actual cancellation block.
        await network.provider.send('hardhat_setNextBlockBaseFeePerGas', [
            '0x2540be400', // 10 gwei
        ]);

        const makerBefore = await ethers.provider.getBalance(maker.address);

        const clone = await ethers.getContractAt('NativeOrderImpl', cloneAddress);
        const tx = await clone.connect(resolver).cancelExpiredOrderByResolver(
            originalOrder,
            rewardCap,
        );
        const receipt = await tx.wait();
        const cancelGasCost = receipt.gasUsed * receipt.gasPrice;
        const cancellationBlock = await ethers.provider.getBlock(receipt.blockNumber);

        expect(cancellationBlock.baseFeePerGas).to.equal(baseFee);
        expect(await weth.balanceOf(cloneAddress)).to.equal(0n);

        const makerAfter = await ethers.provider.getBalance(maker.address);
        const resolverAfter = await ethers.provider.getBalance(resolver.address);
        const makerNativeDelta = makerAfter - makerBefore;
        const resolverNetTotal = resolverAfter - resolverBefore;

        const depositGasCost = depositReceipt.gasUsed * depositReceipt.gasPrice;
        const transferGasCost = transferReceipt.gasUsed * transferReceipt.gasPrice;
        const cancelEvent = getEventArgs(
            receipt,
            clone.interface,
            'NativeOrderCancelledByResolver',
        );
        const resolverReward = cancelEvent[2];

        expect(makerNativeDelta).to.equal(0n);
        expect(resolverReward).to.equal(rewardCap);

        // Complete resolver accounting from the initial balance snapshot:
        // reward - top-up - deposit gas - transfer gas - cancellation gas.
        expect(
            resolverNetTotal
                + topUp
                + depositGasCost
                + transferGasCost
                + cancelGasCost,
        ).to.equal(resolverReward);

        console.log('PARTIAL_FILL_ECONOMIC_EDGE', JSON.stringify({
            initialMakingAmount: initialMakingAmount.toString(),
            residualCollateral: residualCollateral.toString(),
            rewardCap: rewardCap.toString(),
            topUp: topUp.toString(),
            depositGasCost: depositGasCost.toString(),
            transferGasCost: transferGasCost.toString(),
            cancelGasCost: cancelGasCost.toString(),
            victimResidualLoss: residualCollateral.toString(),
            resolverNetTotal: resolverNetTotal.toString(),
            resolverReward: resolverReward.toString(),
        }));
    });
});
