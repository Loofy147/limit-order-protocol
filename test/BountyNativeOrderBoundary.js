const { expect } = require('chai');
const hre = require('hardhat');
const { ethers } = hre;

const {
    ABIOrder,
    buildOrder,
    buildMakerTraits,
} = require('./helpers/orderUtils');
const { ether, getEventArgs } = require('./helpers/utils');

describe('Bounty: NativeOrder ERC-1271 boundary', function () { // execution-control revision
    it('accepts only the factory-committed native order and exact patched hash', async function () {
        const [addr, maker] = await ethers.getSigners();

        const WETH = await ethers.getContractFactory('WrappedTokenMock');
        const weth = await WETH.deploy('WETH', 'WETH');
        await weth.waitForDeployment();

        const DAI = await ethers.getContractFactory('TokenMock');
        const dai = await DAI.deploy('DAI', 'DAI');
        await dai.waitForDeployment();

        const AccessToken = await ethers.getContractFactory('TokenMock');
        const accessToken = await AccessToken.deploy('Access Token', 'ACCESS');
        await accessToken.waitForDeployment();

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

        const order = buildOrder({
            maker: maker.address,
            receiver: maker.address,
            makerAsset: await weth.getAddress(),
            takerAsset: await dai.getAddress(),
            makingAmount: ether('1'),
            takingAmount: ether('1000'),
            makerTraits: buildMakerTraits(),
        });

        const tx = await factory.connect(maker).create(order, { value: order.makingAmount });
        const receipt = await tx.wait();
        const eventArgs = getEventArgs(receipt, factory.interface, 'NativeOrderCreated');
        const cloneAddress = eventArgs[2];
        const emittedPatchedHash = eventArgs[1];

        const patchedOrder = { ...order, maker: cloneAddress };
        const expectedPatchedHash = await lop.hashOrder(patchedOrder);

        expect(emittedPatchedHash).to.equal(expectedPatchedHash);

        const clone = await ethers.getContractAt('NativeOrderImpl', cloneAddress);
        const signature = ethers.AbiCoder.defaultAbiCoder().encode([ABIOrder], [order]);

        expect(
            await clone.isValidSignature(expectedPatchedHash, signature),
        ).to.equal('0x1626ba7e');

        const mutations = [
            ['salt', 2n],
            ['maker', addr.address],
            ['receiver', addr.address],
            ['makerAsset', await dai.getAddress()],
            ['takerAsset', await weth.getAddress()],
            ['makingAmount', ether('2')],
            ['takingAmount', ether('999')],
            ['makerTraits', buildMakerTraits({ allowPartialFill: false })],
        ];

        for (const [field, value] of mutations) {
            const mutated = { ...patchedOrder, [field]: value };
            const mutatedHash = await lop.hashOrder(mutated);
            expect(
                await clone.isValidSignature(mutatedHash, signature),
                field,
            ).to.equal('0x00000000');
        }

        const mutatedSignature = ethers.hexlify(
            ethers.getBytes(signature).map((byte, index) =>
                index === 31 ? (byte ^ 1) : byte,
            ),
        );

        expect(
            await clone.isValidSignature(expectedPatchedHash, mutatedSignature),
        ).to.equal('0x00000000');
    });
});
