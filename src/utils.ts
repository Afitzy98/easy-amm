import { BigNumber } from "@ethersproject/bignumber";
import { Contract } from "@ethersproject/contracts";
import {
  Provider,
  TransactionRequest,
  TransactionResponse,
} from "@ethersproject/providers";
import { formatUnits } from "@ethersproject/units";
import { Wallet } from "@ethersproject/wallet";
import _ from "lodash";

import ERC20ABI from "./abi/ERC20.json";
import PairABI from "./abi/Pair.json";
import RouterABI from "./abi/Router.json";

export interface IReserves {
  _reserve0: BigNumber;
  _reserve1: BigNumber;
}

// typesafe event raiser
type EvtCallback<T> = (data?: T) => void;
export class Evt<T> {
  private _singleCallback: EvtCallback<T> | null = null;
  private _multiCallback = new Array<EvtCallback<T>>();

  public on = (handler: EvtCallback<T>) => {
    if (this._singleCallback) {
      this._multiCallback = [this._singleCallback, handler];
      this._singleCallback = null;
    } else if (this._multiCallback.length > 0) {
      this._multiCallback.push(handler);
    } else {
      this._singleCallback = handler;
    }
  };

  public off = (handler: EvtCallback<T>) => {
    if (this._multiCallback.length > 0)
      this._multiCallback = _.pull(this._multiCallback, handler);
    if (this._singleCallback === handler) this._singleCallback = null;
  };

  public trigger = (data?: T) => {
    if (this._singleCallback !== null) {
      this._singleCallback(data);
    } else {
      const len = this._multiCallback.length;
      for (let i = 0; i < len; i++) this._multiCallback[i](data);
    }
  };
}

export const calcPriceFromReserves = (
  reserves: IReserves,
  is_token0: boolean,
  decimals: number
) =>
  Number(
    formatUnits(
      is_token0
        ? reserves._reserve1
            .mul(BigInt(1e18).toString())
            .div(reserves._reserve0)
        : reserves._reserve0
            .mul(BigInt(1e18).toString())
            .div(reserves._reserve1),
      decimals
    )
  );

export function getAmountIn(
  amount_out: BigNumber,
  reserve_in: BigNumber,
  reserve_out: BigNumber,
  fee = 9975
) {
  const numerator = reserve_in.mul(amount_out).mul(10000);
  const denominator = reserve_out.sub(amount_out).mul(fee);
  return numerator.div(denominator).add(1);
}

export function getAmountOut(
  amount_in: BigNumber,
  reserve_in: BigNumber,
  reserve_out: BigNumber,
  fee = 9975
) {
  const amount_in_with_fee = amount_in.mul(fee);
  const numerator = amount_in_with_fee.mul(reserve_out);
  const denominator = reserve_in.mul(10000).add(amount_in_with_fee);
  return numerator.div(denominator);
}

export function getERC20(address: string, provider: Provider) {
  return new Contract(address, ERC20ABI, provider);
}

export function getPair(address: string, provider: Provider) {
  return new Contract(address, PairABI, provider);
}

export function getRouter(address: string, provider: Provider) {
  return new Contract(address, RouterABI, provider);
}

export class AutoNonceWallet extends Wallet {
  private _noncePromise: Promise<number> | null = null;
  async sendTransaction(
    transaction: TransactionRequest
  ): Promise<TransactionResponse> {
    if (this._noncePromise == null) {
      this._noncePromise = this.provider.getTransactionCount(this.address);
    }
    transaction.nonce = await this._noncePromise;
    this._noncePromise = this._noncePromise.then((nonce) => nonce + 1);

    return super.sendTransaction(transaction);
  }
}
