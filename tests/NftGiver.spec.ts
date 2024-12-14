import { NftGiver, NftGiverConfig, OpCodes, Queries } from '../wrappers/NftGiver';
import { beginCell, Cell, contractAddress } from '@ton/ton';
import { unixNow } from '../lib/utils';
import { compile } from '@ton/blueprint';
import { Blockchain, SandboxContract, TreasuryContract } from '@ton/sandbox';
import { randomAddress } from '@ton/test-utils';

const ROYALTY_ADDRESS = randomAddress();

describe('NftGiver', () => {
    let nftGiverCode: Cell;

    beforeAll(async () => {
        nftGiverCode = await compile('NftGiver');
    });

    let blockchain: Blockchain;

    let sender: SandboxContract<TreasuryContract>;
    let owner: SandboxContract<TreasuryContract>;

    let defaultConfig: NftGiverConfig;

    beforeEach(async () => {
        blockchain = await Blockchain.create();

        sender = await blockchain.treasury('sender');
        owner = await blockchain.treasury('owner');

        defaultConfig = {
            ownerAddress: owner.address,
            nextItemIndex: 777n,
            collectionContent: 'collection_content',
            commonContent: 'common_content',
            nftItemCode: Cell.EMPTY,
            royaltyParams: {
                royaltyFactor: 100n,
                royaltyBase: 200n,
                royaltyAddress: ROYALTY_ADDRESS
            },
            powComplexity: 0n,
            lastSuccess: 0n,
            seed: 0n,
            targetDelta: 15n * 60n, // 15 minutes
            minComplexity: 240n,
            maxComplexity: 252n
        };
    });

    async function deployCollection(collection: SandboxContract<NftGiver>) {
        const { transactions } = await collection.sendDeploy(sender.getSender());
        expect(transactions).toHaveTransaction({
            from: sender.address,
            to: collection.address,
            success: true,
            deploy: true
        });
    }

    it('should mine new nft', async () => {
        const receiver = randomAddress();
        const now = unixNow();
        blockchain.now = now;

        const params = {
            expire: now + 30,
            mintTo: receiver,
            data1: 0n,
            seed: defaultConfig.seed
        };
        const hash = Queries.mine(params).hash();

        const config = {
            ...defaultConfig,
            powComplexity: BigInt('0x' + hash.toString('hex')) + 1n,
            lastSuccess: BigInt(now - 30)
        };

        const collection = blockchain.openContract(NftGiver.createFromConfig(config, nftGiverCode));

        const res = await collection.sendMineNft(sender.getSender(), params);

        // As a result of mint query, collection contract should send stateInit message to NFT item contract
        let nftItemData = beginCell()
            .storeUint(config.nextItemIndex, 64)
            .storeAddress(collection.address)
            .endCell();

        expect(res.transactions).toHaveTransaction({
            success: true,
            deploy: true,
            initCode: config.nftItemCode,
            initData: nftItemData
        });

        const miningData = await collection.getMiningData();

        expect(miningData.powComplexity >= (1n << config.minComplexity)).toBeTruthy();
        expect(miningData.powComplexity <= (1n << config.maxComplexity)).toBeTruthy();
    });


    it('should not mine new nft when POW is not solved', async () => {
        const receiver = randomAddress();
        const now = unixNow();
        blockchain.now = now;

        const params = {
            expire: now + 30,
            mintTo: receiver,
            data1: 0n,
            seed: defaultConfig.seed
        };
        const hash = Queries.mine(params).hash();

        const config = {
            ...defaultConfig,
            powComplexity: BigInt('0x' + hash.toString('hex')),
            lastSuccess: BigInt(now - 30)
        };

        const collection = blockchain.openContract(NftGiver.createFromConfig(config, nftGiverCode));

        const res = await collection.sendMineNft(sender.getSender(), params);
        expect(res.transactions).toHaveTransaction({
            from: sender.address,
            to: collection.address,
            success: false,
            exitCode: 24
        });
    });

    it('should rescale', async () => {
        const config = { ...defaultConfig };
        const now = unixNow();
        blockchain.now = now;

        config.lastSuccess = BigInt(now) - config.targetDelta * 16n;
        config.powComplexity = 1n << config.minComplexity;

        const collection = blockchain.openContract(NftGiver.createFromConfig(config, nftGiverCode));

        const res = await collection.sendRescaleComplexity(sender.getSender(), { expire: now - 1 });

        expect(res.transactions).toHaveTransaction({
            from: sender.address,
            to: collection.address,
            success: true
        });

        const miningData = await collection.getMiningData();

        expect(miningData.powComplexity > config.powComplexity).toBeTruthy();
    });

    it('should not rescale if not enough time passed', async () => {
        const config = { ...defaultConfig };
        const now = unixNow();
        blockchain.now = now;

        config.lastSuccess = BigInt(now) - config.targetDelta * 16n + 1n; // this should make rescale fail

        const collection = blockchain.openContract(NftGiver.createFromConfig(config, nftGiverCode));

        const res = await collection.sendRescaleComplexity(sender.getSender(), { expire: now - 1 });

        expect(res.transactions).toHaveTransaction({
            from: sender.address,
            to: collection.address,
            success: false,
            exitCode: 30
        });
    });

    it('should return collection data', async () => {
        const collection = blockchain.openContract(NftGiver.createFromConfig(defaultConfig, nftGiverCode));
        await deployCollection(collection);

        let res = await collection.getCollectionData();

        expect(res.nextItemId).toEqual(defaultConfig.nextItemIndex);
        expect(res.collectionContent).toEqual(defaultConfig.collectionContent);
        expect(res.ownerAddress).toEqualAddress(defaultConfig.ownerAddress);
    });


    it('should return nft content', async () => {
        const collection = blockchain.openContract(NftGiver.createFromConfig(defaultConfig, nftGiverCode));
        await deployCollection(collection);

        let nftContent = beginCell().storeBuffer(Buffer.from('1')).endCell();
        let res = await collection.getNftContent(0, nftContent);
        expect(res).toEqual(defaultConfig.commonContent + '1');
    });

    it('should return nft address by index', async () => {
        const collection = blockchain.openContract(NftGiver.createFromConfig(defaultConfig, nftGiverCode));
        await deployCollection(collection);

        let index = 77;
        let nftAddress = await collection.getNftAddressByIndex(index);

        // Basic nft item data
        let nftItemData = beginCell()
            .storeUint(index, 64)
            .storeAddress(collection.address)
            .endCell();

        let expectedAddress = contractAddress(0, {
            code: defaultConfig.nftItemCode,
            data: nftItemData
        });

        expect(nftAddress).toEqualAddress(expectedAddress);
    });

    it('should return royalty params', async () => {
        const collection = blockchain.openContract(NftGiver.createFromConfig(defaultConfig, nftGiverCode));
        await deployCollection(collection);

        let res = await collection.getRoyaltyParams();

        expect(res.royaltyBase).toEqual(defaultConfig.royaltyParams.royaltyBase);
        expect(res.royaltyFactor).toEqual(defaultConfig.royaltyParams.royaltyFactor);
        expect(res.royaltyAddress).toEqualAddress(defaultConfig.royaltyParams.royaltyAddress);
    });


    it('should not change owner from not owner', async () => {
        const collection = blockchain.openContract(NftGiver.createFromConfig(defaultConfig, nftGiverCode));

        let newOwner = randomAddress();

        let res = await collection.sendChangeOwner(sender.getSender(), { newOwner });
        expect(res.transactions).toHaveTransaction({
            from: sender.address,
            to: collection.address,
            success: false
        });

        let { ownerAddress } = await collection.getCollectionData();
        expect(ownerAddress).toEqualAddress(owner.address);
    });

    it('should change owner from owner', async () => {
        const collection = blockchain.openContract(NftGiver.createFromConfig(defaultConfig, nftGiverCode));

        let newOwner = randomAddress();

        const res = await collection.sendChangeOwner(owner.getSender(), { newOwner });
        expect(res.transactions).toHaveTransaction({
            from: owner.address,
            to: collection.address,
            success: true
        });

        let { ownerAddress } = await collection.getCollectionData();
        expect(ownerAddress).toEqualAddress(newOwner);
    });

    it('should send royalty params', async () => {
        const collection = blockchain.openContract(NftGiver.createFromConfig(defaultConfig, nftGiverCode));

        let res = await collection.sendGetRoyaltyParams(sender.getSender());
        expect(res.transactions).toHaveTransaction({
            from: sender.address,
            to: collection.address,
            success: true
        });

        expect(res.transactions).toHaveTransaction({
            from: collection.address,
            to: sender.address,
            success: true,
            body: beginCell()
                .storeUint(OpCodes.GetRoyaltyParamsResponse, 32)
                .storeUint(0, 64) // queryId
                .storeUint(defaultConfig.royaltyParams.royaltyFactor, 16)
                .storeUint(defaultConfig.royaltyParams.royaltyBase, 16)
                .storeAddress(ROYALTY_ADDRESS)
                .endCell()
        });
    });

    it('should not edit content from not owner', async () => {
        const collection = blockchain.openContract(NftGiver.createFromConfig(defaultConfig, nftGiverCode));

        let royaltyAddress = randomAddress();
        let res = await collection.sendEditContent(sender.getSender(), {
            collectionContent: 'new_content',
            commonContent: 'new_common_content',
            royaltyParams: {
                royaltyFactor: 150n,
                royaltyBase: 220n,
                royaltyAddress
            }
        });

        expect(res.transactions).toHaveTransaction({
            from: sender.address,
            to: collection.address,
            success: false
        });
    });

    it('should edit content', async () => {
        const collection = blockchain.openContract(NftGiver.createFromConfig(defaultConfig, nftGiverCode));

        let royaltyAddress = randomAddress();
        const res = await collection.sendEditContent(owner.getSender(), {
            collectionContent: 'new_content',
            commonContent: 'new_common_content',
            royaltyParams: {
                royaltyFactor: 150n,
                royaltyBase: 220n,
                royaltyAddress
            }
        });

        expect(res.transactions).toHaveTransaction({
            from: owner.address,
            to: collection.address,
            success: true
        });

        let { collectionContent } = await collection.getCollectionData();
        expect(collectionContent).toEqual('new_content');

        let royalty = await collection.getRoyaltyParams();
        expect(royalty.royaltyBase).toEqual(220n);
        expect(royalty.royaltyFactor).toEqual(150n);
        expect(royalty.royaltyAddress).toEqualAddress(royaltyAddress);
    });

});
