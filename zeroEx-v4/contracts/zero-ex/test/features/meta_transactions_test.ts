import {
    blockchainTests,
    constants,
    expect,
    getRandomInteger,
    randomAddress,
    verifyEventsFromLogs,
} from '@0x/contracts-test-utils';
import { MetaTransaction, MetaTransactionFields } from '@0x/protocol-utils';
import { BigNumber, hexUtils, StringRevertError, ZeroExRevertErrors } from '@0x/utils';
import * as _ from 'lodash';

import { IZeroExContract, MetaTransactionsFeatureContract } from '../../src/wrappers';
import { artifacts } from '../artifacts';
import { abis } from '../utils/abis';
import { fullMigrateAsync } from '../utils/migration';
import { getRandomLimitOrder, getRandomRfqOrder } from '../utils/orders';
import {
    TestMetaTransactionsNativeOrdersFeatureContract,
    TestMetaTransactionsNativeOrdersFeatureEvents,
    TestMetaTransactionsTransformERC20FeatureContract,
    TestMetaTransactionsTransformERC20FeatureEvents,
    TestMintableERC20TokenContract,
} from '../wrappers';

const { NULL_ADDRESS, ZERO_AMOUNT } = constants;

blockchainTests.resets('MetaTransactions feature', env => {
    let owner: string;
    let maker: string;
    let sender: string;
    let notSigner: string;
    const signers: string[] = [];
    let zeroEx: IZeroExContract;
    let feature: MetaTransactionsFeatureContract;
    let feeToken: TestMintableERC20TokenContract;
    let transformERC20Feature: TestMetaTransactionsTransformERC20FeatureContract;
    let nativeOrdersFeature: TestMetaTransactionsNativeOrdersFeatureContract;

    const MAX_FEE_AMOUNT = new BigNumber('1e18');
    const TRANSFORM_ERC20_ONE_WEI_VALUE = new BigNumber(555);
    const TRANSFORM_ERC20_FAILING_VALUE = new BigNumber(666);
    const TRANSFORM_ERC20_REENTER_VALUE = new BigNumber(777);
    const TRANSFORM_ERC20_BATCH_REENTER_VALUE = new BigNumber(888);
    const REENTRANCY_FLAG_MTX = 0x1;

    before(async () => {
        let possibleSigners: string[];
        [owner, maker, sender, notSigner, ...possibleSigners] = await env.getAccountAddressesAsync();
        transformERC20Feature = await TestMetaTransactionsTransformERC20FeatureContract.deployFrom0xArtifactAsync(
            artifacts.TestMetaTransactionsTransformERC20Feature,
            env.provider,
            env.txDefaults,
            {},
        );
        nativeOrdersFeature = await TestMetaTransactionsNativeOrdersFeatureContract.deployFrom0xArtifactAsync(
            artifacts.TestMetaTransactionsNativeOrdersFeature,
            env.provider,
            env.txDefaults,
            {},
        );
        zeroEx = await fullMigrateAsync(owner, env.provider, env.txDefaults, {
            transformERC20: transformERC20Feature.address,
            nativeOrders: nativeOrdersFeature.address,
        });
        feature = new MetaTransactionsFeatureContract(
            zeroEx.address,
            env.provider,
            { ...env.txDefaults, from: sender },
            abis,
        );
        feeToken = await TestMintableERC20TokenContract.deployFrom0xArtifactAsync(
            artifacts.TestMintableERC20Token,
            env.provider,
            env.txDefaults,
            {},
        );

        // some accounts returned can be unfunded
        for (const possibleSigner of possibleSigners) {
            const balance = await env.web3Wrapper.getBalanceInWeiAsync(possibleSigner);
            if (balance.isGreaterThan(0)) {
                signers.push(possibleSigner);
                await feeToken
                    .approve(zeroEx.address, MAX_FEE_AMOUNT)
                    .awaitTransactionSuccessAsync({ from: possibleSigner });
                await feeToken.mint(possibleSigner, MAX_FEE_AMOUNT).awaitTransactionSuccessAsync();
            }
        }
    });

    function getRandomMetaTransaction(fields: Partial<MetaTransactionFields> = {}): MetaTransaction {
        return new MetaTransaction({
            signer: _.sampleSize(signers)[0],
            sender,
            // TODO: dekz Ganache gasPrice opcode is returning 0, cannot influence it up to test this case
            minGasPrice: ZERO_AMOUNT,
            maxGasPrice: getRandomInteger('1e9', '100e9'),
            expirationTimeSeconds: new BigNumber(Math.floor(_.now() / 1000) + 360),
            salt: new BigNumber(hexUtils.random()),
            callData: hexUtils.random(4),
            value: getRandomInteger(1, '1e18'),
            feeToken: feeToken.address,
            feeAmount: getRandomInteger(1, MAX_FEE_AMOUNT),
            chainId: 1337,
            verifyingContract: zeroEx.address,
            ...fields,
        });
    }

    describe('getMetaTransactionHash()', () => {
        it('generates the correct hash', async () => {
            const mtx = getRandomMetaTransaction();
            const expected = mtx.getHash();
            const actual = await feature.getMetaTransactionHash(mtx).callAsync();
            expect(actual).to.eq(expected);
        });
    });

    interface TransformERC20Args {
        inputToken: string;
        outputToken: string;
        inputTokenAmount: BigNumber;
        minOutputTokenAmount: BigNumber;
        transformations: Array<{ deploymentNonce: BigNumber; data: string }>;
    }

    function getRandomTransformERC20Args(fields: Partial<TransformERC20Args> = {}): TransformERC20Args {
        return {
            inputToken: randomAddress(),
            outputToken: randomAddress(),
            inputTokenAmount: getRandomInteger(1, '1e18'),
            minOutputTokenAmount: getRandomInteger(1, '1e18'),
            transformations: [{ deploymentNonce: new BigNumber(123), data: hexUtils.random() }],
            ...fields,
        };
    }

    const RAW_TRANSFORM_SUCCESS_RESULT = hexUtils.leftPad(1337);
    const RAW_ORDER_SUCCESS_RESULT = hexUtils.leftPad(1337, 64);

    describe('executeMetaTransaction()', () => {
        it('can call NativeOrders.fillLimitOrder()', async () => {
            const order = getRandomLimitOrder({ maker });
            const fillAmount = new BigNumber(23456);
            const sig = await order.getSignatureWithProviderAsync(env.provider);
            const mtx = getRandomMetaTransaction({
                callData: nativeOrdersFeature.fillLimitOrder(order, sig, fillAmount).getABIEncodedTransactionData(),
            });
            const signature = await mtx.getSignatureWithProviderAsync(env.provider);
            const callOpts = {
                gasPrice: mtx.minGasPrice,
                value: mtx.value,
            };

            const rawResult = await feature.executeMetaTransaction(mtx, signature).callAsync(callOpts);
            expect(rawResult).to.eq(RAW_ORDER_SUCCESS_RESULT);
            const receipt = await feature.executeMetaTransaction(mtx, signature).awaitTransactionSuccessAsync(callOpts);

            verifyEventsFromLogs(
                receipt.logs,
                [
                    {
                        order: _.omit(order, ['verifyingContract', 'chainId']),
                        sender: mtx.sender,
                        taker: mtx.signer,
                        takerTokenFillAmount: fillAmount,
                        signatureType: sig.signatureType,
                        v: sig.v,
                        r: sig.r,
                        s: sig.s,
                    },
                ],
                TestMetaTransactionsNativeOrdersFeatureEvents.FillLimitOrderCalled,
            );
        });

        it('can call NativeOrders.fillRfqOrder()', async () => {
            const order = getRandomRfqOrder({ maker });
            const sig = await order.getSignatureWithProviderAsync(env.provider);
            const fillAmount = new BigNumber(23456);
            const mtx = getRandomMetaTransaction({
                callData: nativeOrdersFeature.fillRfqOrder(order, sig, fillAmount).getABIEncodedTransactionData(),
                value: ZERO_AMOUNT,
            });
            const signature = await mtx.getSignatureWithProviderAsync(env.provider);
            const callOpts = {
                gasPrice: mtx.minGasPrice,
                value: 0,
            };
            const rawResult = await feature.executeMetaTransaction(mtx, signature).callAsync(callOpts);
            expect(rawResult).to.eq(RAW_ORDER_SUCCESS_RESULT);
            const receipt = await feature.executeMetaTransaction(mtx, signature).awaitTransactionSuccessAsync(callOpts);

            verifyEventsFromLogs(
                receipt.logs,
                [
                    {
                        order: _.omit(order, ['verifyingContract', 'chainId']),
                        taker: mtx.signer,
                        takerTokenFillAmount: fillAmount,
                        signatureType: sig.signatureType,
                        v: sig.v,
                        r: sig.r,
                        s: sig.s,
                    },
                ],
                TestMetaTransactionsNativeOrdersFeatureEvents.FillRfqOrderCalled,
            );
        });

        it('can call `TransformERC20.transformERC20()`', async () => {
            const args = getRandomTransformERC20Args();
            const mtx = getRandomMetaTransaction({
                callData: transformERC20Feature
                    .transformERC20(
                        args.inputToken,
                        args.outputToken,
                        args.inputTokenAmount,
                        args.minOutputTokenAmount,
                        args.transformations,
                    )
                    .getABIEncodedTransactionData(),
            });
            const signature = await mtx.getSignatureWithProviderAsync(env.provider);
            const callOpts = {
                gasPrice: mtx.minGasPrice,
                value: mtx.value,
            };
            const rawResult = await feature.executeMetaTransaction(mtx, signature).callAsync(callOpts);
            expect(rawResult).to.eq(RAW_TRANSFORM_SUCCESS_RESULT);
            const receipt = await feature.executeMetaTransaction(mtx, signature).awaitTransactionSuccessAsync(callOpts);
            verifyEventsFromLogs(
                receipt.logs,
                [
                    {
                        inputToken: args.inputToken,
                        outputToken: args.outputToken,
                        inputTokenAmount: args.inputTokenAmount,
                        minOutputTokenAmount: args.minOutputTokenAmount,
                        transformations: args.transformations,
                        sender: zeroEx.address,
                        value: mtx.value,
                        taker: mtx.signer,
                    },
                ],
                TestMetaTransactionsTransformERC20FeatureEvents.TransformERC20Called,
            );
        });

        it('can call `TransformERC20.transformERC20()` with calldata', async () => {
            const args = getRandomTransformERC20Args();
            const callData = transformERC20Feature
                .transformERC20(
                    args.inputToken,
                    args.outputToken,
                    args.inputTokenAmount,
                    args.minOutputTokenAmount,
                    args.transformations,
                )
                .getABIEncodedTransactionData();
            const mtx = getRandomMetaTransaction({ callData });
            const signature = await mtx.getSignatureWithProviderAsync(env.provider);
            const callOpts = {
                gasPrice: mtx.minGasPrice,
                value: mtx.value,
            };
            const rawResult = await feature.executeMetaTransaction(mtx, signature).callAsync(callOpts);
            expect(rawResult).to.eq(RAW_TRANSFORM_SUCCESS_RESULT);
            const receipt = await feature.executeMetaTransaction(mtx, signature).awaitTransactionSuccessAsync(callOpts);
            verifyEventsFromLogs(
                receipt.logs,
                [
                    {
                        inputToken: args.inputToken,
                        outputToken: args.outputToken,
                        inputTokenAmount: args.inputTokenAmount,
                        minOutputTokenAmount: args.minOutputTokenAmount,
                        transformations: args.transformations,
                        sender: zeroEx.address,
                        value: mtx.value,
                        taker: mtx.signer,
                    },
                ],
                TestMetaTransactionsTransformERC20FeatureEvents.TransformERC20Called,
            );
        });

        it('can call with any sender if `sender == 0`', async () => {
            const args = getRandomTransformERC20Args();
            const mtx = getRandomMetaTransaction({
                sender: NULL_ADDRESS,
                callData: transformERC20Feature
                    .transformERC20(
                        args.inputToken,
                        args.outputToken,
                        args.inputTokenAmount,
                        args.minOutputTokenAmount,
                        args.transformations,
                    )
                    .getABIEncodedTransactionData(),
            });
            const signature = await mtx.getSignatureWithProviderAsync(env.provider);
            const callOpts = {
                gasPrice: mtx.minGasPrice,
                value: mtx.value,
                from: randomAddress(),
            };
            const rawResult = await feature.executeMetaTransaction(mtx, signature).callAsync(callOpts);
            expect(rawResult).to.eq(RAW_TRANSFORM_SUCCESS_RESULT);
        });

        it('works without fee', async () => {
            const args = getRandomTransformERC20Args();
            const mtx = getRandomMetaTransaction({
                feeAmount: ZERO_AMOUNT,
                feeToken: randomAddress(),
                callData: transformERC20Feature
                    .transformERC20(
                        args.inputToken,
                        args.outputToken,
                        args.inputTokenAmount,
                        args.minOutputTokenAmount,
                        args.transformations,
                    )
                    .getABIEncodedTransactionData(),
            });
            const signature = await mtx.getSignatureWithProviderAsync(env.provider);
            const callOpts = {
                gasPrice: mtx.minGasPrice,
                value: mtx.value,
            };
            const rawResult = await feature.executeMetaTransaction(mtx, signature).callAsync(callOpts);
            expect(rawResult).to.eq(RAW_TRANSFORM_SUCCESS_RESULT);
        });

        it('fails if the translated call fails', async () => {
            const args = getRandomTransformERC20Args();
            const mtx = getRandomMetaTransaction({
                value: new BigNumber(TRANSFORM_ERC20_FAILING_VALUE),
                callData: transformERC20Feature
                    .transformERC20(
                        args.inputToken,
                        args.outputToken,
                        args.inputTokenAmount,
                        args.minOutputTokenAmount,
                        args.transformations,
                    )
                    .getABIEncodedTransactionData(),
            });
            const mtxHash = mtx.getHash();
            const signature = await mtx.getSignatureWithProviderAsync(env.provider);
            const callOpts = {
                gasPrice: mtx.minGasPrice,
                value: mtx.value,
            };
            const tx = feature.executeMetaTransaction(mtx, signature).callAsync(callOpts);
            const actualCallData = transformERC20Feature
                ._transformERC20({
                    taker: mtx.signer,
                    inputToken: args.inputToken,
                    outputToken: args.outputToken,
                    inputTokenAmount: args.inputTokenAmount,
                    minOutputTokenAmount: args.minOutputTokenAmount,
                    transformations: args.transformations,
                    useSelfBalance: false,
                    recipient: mtx.signer,
                })
                .getABIEncodedTransactionData();
            return expect(tx).to.revertWith(
                new ZeroExRevertErrors.MetaTransactions.MetaTransactionCallFailedError(
                    mtxHash,
                    actualCallData,
                    new StringRevertError('FAIL').encode(),
                ),
            );
        });

        it('fails with unsupported function', async () => {
            const mtx = getRandomMetaTransaction({
                callData: transformERC20Feature.createTransformWallet().getABIEncodedTransactionData(),
            });
            const mtxHash = mtx.getHash();
            const signature = await mtx.getSignatureWithProviderAsync(env.provider);
            const callOpts = {
                gasPrice: mtx.minGasPrice,
                value: mtx.value,
            };
            const tx = feature.executeMetaTransaction(mtx, signature).awaitTransactionSuccessAsync(callOpts);
            return expect(tx).to.revertWith(
                new ZeroExRevertErrors.MetaTransactions.MetaTransactionUnsupportedFunctionError(
                    mtxHash,
                    hexUtils.slice(mtx.callData, 0, 4),
                ),
            );
        });

        it('cannot execute the same mtx twice', async () => {
            const args = getRandomTransformERC20Args();
            const mtx = getRandomMetaTransaction({
                callData: transformERC20Feature
                    .transformERC20(
                        args.inputToken,
                        args.outputToken,
                        args.inputTokenAmount,
                        args.minOutputTokenAmount,
                        args.transformations,
                    )
                    .getABIEncodedTransactionData(),
            });
            const mtxHash = mtx.getHash();
            const signature = await mtx.getSignatureWithProviderAsync(env.provider);
            const callOpts = {
                gasPrice: mtx.minGasPrice,
                value: mtx.value,
            };
            const receipt = await feature.executeMetaTransaction(mtx, signature).awaitTransactionSuccessAsync(callOpts);
            const tx = feature.executeMetaTransaction(mtx, signature).awaitTransactionSuccessAsync(callOpts);
            return expect(tx).to.revertWith(
                new ZeroExRevertErrors.MetaTransactions.MetaTransactionAlreadyExecutedError(
                    mtxHash,
                    receipt.blockNumber,
                ),
            );
        });

        it('fails if not enough ETH provided', async () => {
            const mtx = getRandomMetaTransaction();
            const mtxHash = mtx.getHash();
            const signature = await mtx.getSignatureWithProviderAsync(env.provider);
            const callOpts = {
                gasPrice: mtx.minGasPrice,
                value: mtx.value.minus(1),
            };
            const tx = feature.executeMetaTransaction(mtx, signature).awaitTransactionSuccessAsync(callOpts);
            return expect(tx).to.revertWith(
                new ZeroExRevertErrors.MetaTransactions.MetaTransactionInsufficientEthError(
                    mtxHash,
                    callOpts.value,
                    mtx.value,
                ),
            );
        });

        // Ganache gasPrice opcode is returning 0, cannot influence it up to test this case
        it.skip('fails if gas price too low', async () => {
            const mtx = getRandomMetaTransaction();
            const mtxHash = mtx.getHash();
            const signature = await mtx.getSignatureWithProviderAsync(env.provider);
            const callOpts = {
                gasPrice: mtx.minGasPrice.minus(1),
                value: mtx.value,
            };
            const tx = feature.executeMetaTransaction(mtx, signature).awaitTransactionSuccessAsync(callOpts);
            return expect(tx).to.revertWith(
                new ZeroExRevertErrors.MetaTransactions.MetaTransactionGasPriceError(
                    mtxHash,
                    callOpts.gasPrice,
                    mtx.minGasPrice,
                    mtx.maxGasPrice,
                ),
            );
        });

        // Ganache gasPrice opcode is returning 0, cannot influence it up to test this case
        it.skip('fails if gas price too high', async () => {
            const mtx = getRandomMetaTransaction();
            const mtxHash = mtx.getHash();
            const signature = await mtx.getSignatureWithProviderAsync(env.provider);
            const callOpts = {
                gasPrice: mtx.maxGasPrice.plus(1),
                value: mtx.value,
            };
            const tx = feature.executeMetaTransaction(mtx, signature).awaitTransactionSuccessAsync(callOpts);
            return expect(tx).to.revertWith(
                new ZeroExRevertErrors.MetaTransactions.MetaTransactionGasPriceError(
                    mtxHash,
                    callOpts.gasPrice,
                    mtx.minGasPrice,
                    mtx.maxGasPrice,
                ),
            );
        });

        it('fails if expired', async () => {
            const mtx = getRandomMetaTransaction({
                expirationTimeSeconds: new BigNumber(Math.floor(_.now() / 1000 - 60)),
            });
            const mtxHash = mtx.getHash();
            const signature = await mtx.getSignatureWithProviderAsync(env.provider);
            const callOpts = {
                gasPrice: mtx.maxGasPrice,
                value: mtx.value,
            };
            const tx = feature.executeMetaTransaction(mtx, signature).awaitTransactionSuccessAsync(callOpts);
            return expect(tx).to.revertWith(
                new ZeroExRevertErrors.MetaTransactions.MetaTransactionExpiredError(
                    mtxHash,
                    undefined,
                    mtx.expirationTimeSeconds,
                ),
            );
        });

        it('fails if wrong sender', async () => {
            const requiredSender = randomAddress();
            const mtx = getRandomMetaTransaction({
                sender: requiredSender,
            });
            const mtxHash = mtx.getHash();
            const signature = await mtx.getSignatureWithProviderAsync(env.provider);
            const callOpts = {
                gasPrice: mtx.maxGasPrice,
                value: mtx.value,
            };
            const tx = feature.executeMetaTransaction(mtx, signature).awaitTransactionSuccessAsync(callOpts);
            return expect(tx).to.revertWith(
                new ZeroExRevertErrors.MetaTransactions.MetaTransactionWrongSenderError(
                    mtxHash,
                    sender,
                    requiredSender,
                ),
            );
        });

        it('fails if signature is wrong', async () => {
            const mtx = getRandomMetaTransaction({ signer: signers[0] });
            const mtxHash = mtx.getHash();
            const signature = await mtx.clone({ signer: notSigner }).getSignatureWithProviderAsync(env.provider);
            const callOpts = {
                gasPrice: mtx.maxGasPrice,
                value: mtx.value,
            };
            const tx = feature.executeMetaTransaction(mtx, signature).awaitTransactionSuccessAsync(callOpts);
            return expect(tx).to.revertWith(
                new ZeroExRevertErrors.SignatureValidator.SignatureValidationError(
                    ZeroExRevertErrors.SignatureValidator.SignatureValidationErrorCodes.WrongSigner,
                    mtxHash,
                    signers[0],
                    '0x',
                ),
            );
        });

        it('cannot reenter `executeMetaTransaction()`', async () => {
            const args = getRandomTransformERC20Args();
            const mtx = getRandomMetaTransaction({
                callData: transformERC20Feature
                    .transformERC20(
                        args.inputToken,
                        args.outputToken,
                        args.inputTokenAmount,
                        args.minOutputTokenAmount,
                        args.transformations,
                    )
                    .getABIEncodedTransactionData(),
                value: TRANSFORM_ERC20_REENTER_VALUE,
            });
            const mtxHash = mtx.getHash();
            const signature = await mtx.getSignatureWithProviderAsync(env.provider);
            const callOpts = {
                gasPrice: mtx.maxGasPrice,
                value: mtx.value,
            };
            const tx = feature.executeMetaTransaction(mtx, signature).awaitTransactionSuccessAsync(callOpts);
            return expect(tx).to.revertWith(
                new ZeroExRevertErrors.MetaTransactions.MetaTransactionCallFailedError(
                    mtxHash,
                    undefined,
                    new ZeroExRevertErrors.Common.IllegalReentrancyError(
                        feature.getSelector('executeMetaTransaction'),
                        REENTRANCY_FLAG_MTX,
                    ).encode(),
                ),
            );
        });

        it('cannot reenter `batchExecuteMetaTransactions()`', async () => {
            const args = getRandomTransformERC20Args();
            const mtx = getRandomMetaTransaction({
                callData: transformERC20Feature
                    .transformERC20(
                        args.inputToken,
                        args.outputToken,
                        args.inputTokenAmount,
                        args.minOutputTokenAmount,
                        args.transformations,
                    )
                    .getABIEncodedTransactionData(),
                value: TRANSFORM_ERC20_BATCH_REENTER_VALUE,
            });
            const mtxHash = mtx.getHash();
            const signature = await mtx.getSignatureWithProviderAsync(env.provider);
            const callOpts = {
                gasPrice: mtx.maxGasPrice,
                value: mtx.value,
            };
            const tx = feature.executeMetaTransaction(mtx, signature).awaitTransactionSuccessAsync(callOpts);
            return expect(tx).to.revertWith(
                new ZeroExRevertErrors.MetaTransactions.MetaTransactionCallFailedError(
                    mtxHash,
                    undefined,
                    new ZeroExRevertErrors.Common.IllegalReentrancyError(
                        feature.getSelector('batchExecuteMetaTransactions'),
                        REENTRANCY_FLAG_MTX,
                    ).encode(),
                ),
            );
        });

        it('cannot reduce initial ETH balance', async () => {
            const args = getRandomTransformERC20Args();
            const mtx = getRandomMetaTransaction({
                callData: transformERC20Feature
                    .transformERC20(
                        args.inputToken,
                        args.outputToken,
                        args.inputTokenAmount,
                        args.minOutputTokenAmount,
                        args.transformations,
                    )
                    .getABIEncodedTransactionData(),
                value: TRANSFORM_ERC20_ONE_WEI_VALUE,
            });
            const signature = await mtx.getSignatureWithProviderAsync(env.provider);
            const callOpts = {
                gasPrice: mtx.maxGasPrice,
                value: mtx.value,
            };
            // Send pre-existing ETH to the EP.
            await env.web3Wrapper.awaitTransactionSuccessAsync(
                await env.web3Wrapper.sendTransactionAsync({
                    from: owner,
                    to: zeroEx.address,
                    value: new BigNumber(1),
                }),
            );
            const tx = feature.executeMetaTransaction(mtx, signature).awaitTransactionSuccessAsync(callOpts);
            return expect(tx).to.revertWith('MetaTransactionsFeature/ETH_LEAK');
        });
    });

    describe('batchExecuteMetaTransactions()', () => {
        it('can execute multiple transactions', async () => {
            const mtxs = _.times(2, i => {
                const args = getRandomTransformERC20Args();
                return getRandomMetaTransaction({
                    signer: signers[i],
                    callData: transformERC20Feature
                        .transformERC20(
                            args.inputToken,
                            args.outputToken,
                            args.inputTokenAmount,
                            args.minOutputTokenAmount,
                            args.transformations,
                        )
                        .getABIEncodedTransactionData(),
                });
            });
            const signatures = await Promise.all(
                mtxs.map(async mtx => mtx.getSignatureWithProviderAsync(env.provider)),
            );
            const callOpts = {
                gasPrice: BigNumber.max(...mtxs.map(mtx => mtx.minGasPrice)),
                value: BigNumber.sum(...mtxs.map(mtx => mtx.value)),
            };
            const rawResults = await feature.batchExecuteMetaTransactions(mtxs, signatures).callAsync(callOpts);
            expect(rawResults).to.eql(mtxs.map(() => RAW_TRANSFORM_SUCCESS_RESULT));
        });

        it('cannot execute the same transaction twice', async () => {
            const mtx = (() => {
                const args = getRandomTransformERC20Args();
                return getRandomMetaTransaction({
                    signer: _.sampleSize(signers, 1)[0],
                    callData: transformERC20Feature
                        .transformERC20(
                            args.inputToken,
                            args.outputToken,
                            args.inputTokenAmount,
                            args.minOutputTokenAmount,
                            args.transformations,
                        )
                        .getABIEncodedTransactionData(),
                });
            })();
            const mtxHash = mtx.getHash();
            const mtxs = _.times(2, () => mtx);
            const signatures = await Promise.all(mtxs.map(async m => m.getSignatureWithProviderAsync(env.provider)));
            const callOpts = {
                gasPrice: BigNumber.max(...mtxs.map(m => m.minGasPrice)),
                value: BigNumber.sum(...mtxs.map(m => m.value)),
            };
            const block = await env.web3Wrapper.getBlockNumberAsync();
            const tx = feature.batchExecuteMetaTransactions(mtxs, signatures).callAsync(callOpts);
            return expect(tx).to.revertWith(
                new ZeroExRevertErrors.MetaTransactions.MetaTransactionAlreadyExecutedError(mtxHash, block),
            );
        });

        it('fails if a meta-transaction fails', async () => {
            const args = getRandomTransformERC20Args();
            const mtx = getRandomMetaTransaction({
                value: new BigNumber(TRANSFORM_ERC20_FAILING_VALUE),
                callData: transformERC20Feature
                    .transformERC20(
                        args.inputToken,
                        args.outputToken,
                        args.inputTokenAmount,
                        args.minOutputTokenAmount,
                        args.transformations,
                    )
                    .getABIEncodedTransactionData(),
            });
            const mtxHash = mtx.getHash();
            const signature = await mtx.getSignatureWithProviderAsync(env.provider);
            const callOpts = {
                gasPrice: mtx.minGasPrice,
                value: mtx.value,
            };
            const tx = feature.batchExecuteMetaTransactions([mtx], [signature]).callAsync(callOpts);
            return expect(tx).to.revertWith(
                new ZeroExRevertErrors.MetaTransactions.MetaTransactionCallFailedError(
                    mtxHash,
                    undefined,
                    new StringRevertError('FAIL').encode(),
                ),
            );
        });

        it('cannot reenter `executeMetaTransaction()`', async () => {
            const args = getRandomTransformERC20Args();
            const mtx = getRandomMetaTransaction({
                callData: transformERC20Feature
                    .transformERC20(
                        args.inputToken,
                        args.outputToken,
                        args.inputTokenAmount,
                        args.minOutputTokenAmount,
                        args.transformations,
                    )
                    .getABIEncodedTransactionData(),
                value: TRANSFORM_ERC20_REENTER_VALUE,
            });
            const mtxHash = mtx.getHash();
            const signature = await mtx.getSignatureWithProviderAsync(env.provider);
            const callOpts = {
                gasPrice: mtx.maxGasPrice,
                value: mtx.value,
            };
            const tx = feature.batchExecuteMetaTransactions([mtx], [signature]).awaitTransactionSuccessAsync(callOpts);
            return expect(tx).to.revertWith(
                new ZeroExRevertErrors.MetaTransactions.MetaTransactionCallFailedError(
                    mtxHash,
                    undefined,
                    new ZeroExRevertErrors.Common.IllegalReentrancyError(
                        feature.getSelector('executeMetaTransaction'),
                        REENTRANCY_FLAG_MTX,
                    ).encode(),
                ),
            );
        });

        it('cannot reenter `batchExecuteMetaTransactions()`', async () => {
            const args = getRandomTransformERC20Args();
            const mtx = getRandomMetaTransaction({
                callData: transformERC20Feature
                    .transformERC20(
                        args.inputToken,
                        args.outputToken,
                        args.inputTokenAmount,
                        args.minOutputTokenAmount,
                        args.transformations,
                    )
                    .getABIEncodedTransactionData(),
                value: TRANSFORM_ERC20_BATCH_REENTER_VALUE,
            });
            const mtxHash = mtx.getHash();
            const signature = await mtx.getSignatureWithProviderAsync(env.provider);
            const callOpts = {
                gasPrice: mtx.maxGasPrice,
                value: mtx.value,
            };
            const tx = feature.batchExecuteMetaTransactions([mtx], [signature]).awaitTransactionSuccessAsync(callOpts);
            return expect(tx).to.revertWith(
                new ZeroExRevertErrors.MetaTransactions.MetaTransactionCallFailedError(
                    mtxHash,
                    undefined,
                    new ZeroExRevertErrors.Common.IllegalReentrancyError(
                        feature.getSelector('batchExecuteMetaTransactions'),
                        REENTRANCY_FLAG_MTX,
                    ).encode(),
                ),
            );
        });

        it('cannot reduce initial ETH balance', async () => {
            const args = getRandomTransformERC20Args();
            const mtx = getRandomMetaTransaction({
                callData: transformERC20Feature
                    .transformERC20(
                        args.inputToken,
                        args.outputToken,
                        args.inputTokenAmount,
                        args.minOutputTokenAmount,
                        args.transformations,
                    )
                    .getABIEncodedTransactionData(),
                value: TRANSFORM_ERC20_ONE_WEI_VALUE,
            });
            const signature = await mtx.getSignatureWithProviderAsync(env.provider);
            const callOpts = {
                gasPrice: mtx.maxGasPrice,
                value: mtx.value,
            };
            // Send pre-existing ETH to the EP.
            await env.web3Wrapper.awaitTransactionSuccessAsync(
                await env.web3Wrapper.sendTransactionAsync({
                    from: owner,
                    to: zeroEx.address,
                    value: new BigNumber(1),
                }),
            );
            const tx = feature.batchExecuteMetaTransactions([mtx], [signature]).awaitTransactionSuccessAsync(callOpts);
            return expect(tx).to.revertWith('MetaTransactionsFeature/ETH_LEAK');
        });
    });

    describe('getMetaTransactionExecutedBlock()', () => {
        it('returns zero for an unexecuted mtx', async () => {
            const mtx = getRandomMetaTransaction();
            const block = await feature.getMetaTransactionExecutedBlock(mtx).callAsync();
            expect(block).to.bignumber.eq(0);
        });

        it('returns the block it was executed in', async () => {
            const args = getRandomTransformERC20Args();
            const mtx = getRandomMetaTransaction({
                callData: transformERC20Feature
                    .transformERC20(
                        args.inputToken,
                        args.outputToken,
                        args.inputTokenAmount,
                        args.minOutputTokenAmount,
                        args.transformations,
                    )
                    .getABIEncodedTransactionData(),
            });
            const signature = await mtx.getSignatureWithProviderAsync(env.provider);
            const callOpts = {
                gasPrice: mtx.minGasPrice,
                value: mtx.value,
            };
            const receipt = await feature.executeMetaTransaction(mtx, signature).awaitTransactionSuccessAsync(callOpts);
            const block = await feature.getMetaTransactionExecutedBlock(mtx).callAsync();
            expect(block).to.bignumber.eq(receipt.blockNumber);
        });
    });

    describe('getMetaTransactionHashExecutedBlock()', () => {
        it('returns zero for an unexecuted mtx', async () => {
            const mtx = getRandomMetaTransaction();
            const mtxHash = mtx.getHash();
            const block = await feature.getMetaTransactionHashExecutedBlock(mtxHash).callAsync();
            expect(block).to.bignumber.eq(0);
        });

        it('returns the block it was executed in', async () => {
            const args = getRandomTransformERC20Args();
            const mtx = getRandomMetaTransaction({
                callData: transformERC20Feature
                    .transformERC20(
                        args.inputToken,
                        args.outputToken,
                        args.inputTokenAmount,
                        args.minOutputTokenAmount,
                        args.transformations,
                    )
                    .getABIEncodedTransactionData(),
            });
            const signature = await mtx.getSignatureWithProviderAsync(env.provider);
            const callOpts = {
                gasPrice: mtx.minGasPrice,
                value: mtx.value,
            };
            const receipt = await feature.executeMetaTransaction(mtx, signature).awaitTransactionSuccessAsync(callOpts);
            const mtxHash = mtx.getHash();
            const block = await feature.getMetaTransactionHashExecutedBlock(mtxHash).callAsync();
            expect(block).to.bignumber.eq(receipt.blockNumber);
        });
    });
});
