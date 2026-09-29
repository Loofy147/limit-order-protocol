const { expect } = require('chai');
const hre = require('hardhat');
const { ethers } = hre;

const { ABIOrder, buildOrder, buildMakerTraits } = require('./helpers/orderUtils');
const { ether, getEventArgs } = require('./helpers/utils');

describe('Bounty: NativeOrder clone isolation', function () {
    async function deployFixture() {
        const [attacker, maker] = await ethers.getSigners();

        const TokenMock = await ethers.getContractFactory('TokenMock');
        const dai = await TokenMock.deploy('DAI', 'DAI');
        await dai.waitForDeployment();

        const AccessToken = await ethers.getContractFactory('TokenMock');
        const accessToken = await AccessToken.deploy('Access Token', 'ACCESS');
        await accessToken.waitForDeployment();

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

        const baseOrder = buildOrder({
            maker: maker.address,
            receiver: maker.address,
            makerAsset: await weth.getAddress(),
            takerAsset: await dai.getAddress(),
            makingAmount: ether('1'),
            takingAmount: ether('1000'),
            makerTraits: buildMakerTraits(),
        });

        const order1 = { ...baseOrder, salt: 1n };
        const order2 = { ...baseOrder, salt: 2n };

        const receipt1 = await (await factory.connect(maker).create(order1, { value: order1.makingAmount })).wait();
        const receipt2 = await (await factory.connect(maker).create(order2, { value: order2.makingAmount })).wait();

        const clone1 = getEventArgs(receipt1, factory.interface, 'NativeOrderCreated')[2];
        const clone2 = getEventArgs(receipt2, factory.interface, 'NativeOrderCreated')[2];

        return { attacker, maker, weth, lop, factory, order1, order2, clone1, clone2 };
    }

    it('does not let a same-maker order validate against the wrong clone', async function () {
        const {
            weth,
            lop,
            maker,
            order1,
            order2,
            clone1,
            clone2,
        } = await deployFixture();

        const clone1Contract = await ethers.getContractAt('NativeOrderImpl', clone1);
        const clone2Contract = await ethers.getContractAt('NativeOrderImpl', clone2);

        const patched1 = { ...order1, maker: clone1 };
        const patched2 = { ...order2, maker: clone2 };
        const hash1 = await lop.hashOrder(patched1);
        const hash2 = await lop.hashOrder(patched2);
        const signature1 = ethers.AbiCoder.defaultAbiCoder().encode([ABIOrder], [order1]);

        expect(await clone1Contract.isValidSignature(hash1, signature1)).to.equal('0x1626ba7e');
        expect(await clone2Contract.isValidSignature(hash1, signature1)).to.equal('0x00000000');

        await expect(
            clone1Contract.connect(maker).withdraw(
                order2,
                await weth.getAddress(),
                0,
                weth.interface.encodeFunctionData('transfer', [maker.address, order2.makingAmount]),
            ),
        ).to.be.revertedWithCustomError(clone1Contract, 'OrderIsIncorrect');

        await expect(
            clone1Contract.connect(maker).cancelOrder(order2),
        ).to.be.revertedWithCustomError(clone1Contract, 'OrderIsIncorrect');

        expect(hash2).to.not.equal(hash1);
    });
});
