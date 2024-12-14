import { decodeOffChainContent, encodeOffChainContent } from '../lib/utils';
import {
    Address,
    beginCell,
    Cell,
    Contract,
    contractAddress,
    ContractProvider,
    Sender,
    SendMode,
    toNano,
    TupleBuilder
} from '@ton/ton';

export type RoyaltyParams = {
    royaltyFactor: bigint;
    royaltyBase: bigint;
    royaltyAddress: Address;
}

export type MiningData = {
    powComplexity: bigint;
    lastSuccess: bigint;
    seed: bigint;
    targetDelta: bigint;
    minComplexity: bigint;
    maxComplexity: bigint;
}

export type NftGiverConfig = {
    ownerAddress: Address;
    nextItemIndex: number | bigint;
    collectionContent: string;
    commonContent: string;
    nftItemCode: Cell;
    royaltyParams: RoyaltyParams;
} & MiningData

// default#_ royalty_factor:uint16 royalty_base:uint16 royalty_address:MsgAddress = RoyaltyParams;
//
// storage#_
//  owner_address:MsgAddress next_item_index:uint64
//  ^[collection_content:^Cell common_content:^Cell]
//  nft_item_code:^Cell
//  royalty_params:^RoyaltyParams
//  = Storage;
export function nftGiverConfigToCell(data: NftGiverConfig) {
    let collectionContent = encodeOffChainContent(data.collectionContent);

    let commonContent = beginCell()
        .storeBuffer(Buffer.from(data.commonContent))
        .endCell();

    let contentCell = beginCell()
        .storeRef(collectionContent)
        .storeRef(commonContent)
        .endCell();

    let royaltyCell = beginCell()
        .storeUint(data.royaltyParams.royaltyFactor, 16)
        .storeUint(data.royaltyParams.royaltyBase, 16)
        .storeAddress(data.royaltyParams.royaltyAddress)
        .endCell();

    return beginCell()
        .storeAddress(data.ownerAddress)
        .storeUint(data.nextItemIndex, 64)
        .storeUint(data.powComplexity, 256)
        .storeUint(data.lastSuccess, 32)
        .storeUint(data.seed, 128)
        .storeUint(data.targetDelta, 32)
        .storeUint(data.minComplexity, 8)
        .storeUint(data.maxComplexity, 8)
        .storeRef(contentCell)
        .storeRef(data.nftItemCode)
        .storeRef(royaltyCell)
        .endCell();
}

export const OpCodes = {
    ChangeOwner: 3,
    EditContent: 4,
    GetRoyaltyParams: 0x693d3950,
    GetRoyaltyParamsResponse: 0xa8cb00ad,
    Mine: 0x4d696e65,
    RescaleComplexity: 0x5253636c
};

export type MineMessageParams = {
    expire: number;
    mintTo: Address;
    data1: bigint;
    seed: bigint;
    data2?: bigint;
}

export const Queries = {
    changeOwner: (params: { queryId?: number, newOwner: Address }) => {
        return beginCell()
            .storeUint(OpCodes.ChangeOwner, 32)
            .storeUint(params.queryId ?? 0, 64)
            .storeAddress(params.newOwner)
            .endCell();
    },
    getRoyaltyParams: (params: { queryId?: number }) => {
        return beginCell()
            .storeUint(OpCodes.GetRoyaltyParams, 32)
            .storeUint(params.queryId ?? 0, 64)
            .endCell();
    },
    editContent: (params: {
        queryId?: number,
        collectionContent: string,
        commonContent: string,
        royaltyParams: RoyaltyParams
    }) => {
        let msgBody = beginCell()
            .storeUint(OpCodes.EditContent, 32)
            .storeUint(params.queryId || 0, 64);

        let royaltyCell = beginCell()
            .storeUint(params.royaltyParams.royaltyFactor, 16)
            .storeUint(params.royaltyParams.royaltyBase, 16)
            .storeAddress(params.royaltyParams.royaltyAddress)
            .endCell();

        let collectionContent = encodeOffChainContent(params.collectionContent);

        let commonContent = beginCell()
            .storeBuffer(Buffer.from(params.commonContent))
            .endCell();

        let contentCell = beginCell()
            .storeRef(collectionContent)
            .storeRef(commonContent)
            .endCell();

        return msgBody
            .storeRef(contentCell)
            .storeRef(royaltyCell)
            .endCell();
    },
    mine: (params: MineMessageParams) => beginCell()
        .storeUint(OpCodes.Mine, 32)
        .storeUint(params.expire, 32)
        .storeAddress(params.mintTo)
        .storeUint(params.data1, 256)
        .storeUint(params.seed, 128)
        .storeUint(params.data2 ?? params.data1, 256)
        .endCell(),
    rescaleComplexity: (params: { queryId?: number, expire: number }) => beginCell()
        .storeUint(OpCodes.RescaleComplexity, 32)
        .storeUint(params.queryId ?? 0, 64)
        .storeUint(params.expire, 32)
        .endCell()
};

export class NftGiver implements Contract {
    private constructor(
        readonly address: Address,
        readonly init?: { code: Cell; data: Cell }
    ) {
    }

    static createFromConfig(config: NftGiverConfig, code: Cell, workchain = 0) {
        const data = nftGiverConfigToCell(config);
        const init = { code, data };
        return new NftGiver(contractAddress(workchain, init), init);
    }

    static createFromAddress(address: Address) {
        return new NftGiver(address);
    }

    async getCollectionData(provider: ContractProvider): Promise<{
        nextItemId: bigint,
        ownerAddress: Address,
        collectionContent: string
    }> {
        let { stack } = await provider.get('get_collection_data', []);

        return {
            nextItemId: stack.readBigNumber(),
            collectionContent: decodeOffChainContent(stack.readCell()),
            ownerAddress: stack.readAddress()
        };
    }

    async getNftAddressByIndex(provider: ContractProvider, index: bigint | number): Promise<Address> {
        let res = await provider.get('get_nft_address_by_index', [{ type: 'int', value: BigInt(index) }]);

        return res.stack.readAddress();
    }

    async getRoyaltyParams(provider: ContractProvider): Promise<RoyaltyParams> {
        let { stack } = await provider.get('royalty_params', []);

        return {
            royaltyFactor: stack.readBigNumber(),
            royaltyBase: stack.readBigNumber(),
            royaltyAddress: stack.readAddress()
        };
    }

    async getNftContent(provider: ContractProvider, index: number | bigint, nftIndividualContent: Cell): Promise<string> {
        const builder = new TupleBuilder();
        builder.writeNumber(index);
        builder.writeCell(nftIndividualContent);
        let { stack } = await provider.get('get_nft_content', builder.build());

        return decodeOffChainContent(stack.readCell());
    }

    async getMiningData(provider: ContractProvider): Promise<MiningData> {
        let { stack } = await provider.get('get_mining_data', []);

        return {
            powComplexity: stack.readBigNumber(),
            lastSuccess: stack.readBigNumber(),
            seed: stack.readBigNumber(),
            targetDelta: stack.readBigNumber(),
            minComplexity: stack.readBigNumber(),
            maxComplexity: stack.readBigNumber()
        };
    }

    async sendChangeOwner(provider: ContractProvider, via: Sender, params: {
        newOwner: Address,
        value?: bigint
    }) {
        return await provider.internal(via, {
            value: params.value ?? toNano(1),
            sendMode: SendMode.PAY_GAS_SEPARATELY,
            bounce: false,
            body: Queries.changeOwner(params)
        });
    }

    async sendGetRoyaltyParams(provider: ContractProvider, via: Sender, value: bigint = toNano(1)) {
        return provider.internal(via, {
            value,
            bounce: false,
            sendMode: SendMode.PAY_GAS_SEPARATELY,
            body: Queries.getRoyaltyParams({})
        });
    }

    async sendEditContent(provider: ContractProvider, via: Sender, params: {
        value?: bigint
        queryId?: number,
        collectionContent: string,
        commonContent: string,
        royaltyParams: RoyaltyParams,
    }) {
        return provider.internal(via, {
            value: params.value ?? toNano(1),
            bounce: false,
            sendMode: SendMode.PAY_GAS_SEPARATELY,
            body: Queries.editContent(params)
        });
    }

    async sendMineNft(provider: ContractProvider, via: Sender, params: {
        queryId?: number;
        value?: bigint;
    } & MineMessageParams) {
        return provider.internal(via, {
            value: params.value ?? toNano(1),
            bounce: false,
            sendMode: SendMode.PAY_GAS_SEPARATELY,
            body: Queries.mine(params)
        });
    }

    async sendRescaleComplexity(provider: ContractProvider, via: Sender, params: {
        queryId?: number,
        expire: number,
        value?: bigint;
    }) {
        return provider.internal(via, {
            value: params.value ?? toNano(1),
            bounce: false,
            sendMode: SendMode.PAY_GAS_SEPARATELY,
            body: Queries.rescaleComplexity(params)
        });
    }

    async sendDeploy(provider: ContractProvider, via: Sender, value: bigint = toNano(1)) {
        return provider.internal(via, {
            value,
            bounce: false,
            sendMode: SendMode.PAY_GAS_SEPARATELY,
            body: beginCell().endCell()
        });
    }
}
