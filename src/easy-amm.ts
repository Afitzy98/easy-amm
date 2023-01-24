import { BigNumber } from "@ethersproject/bignumber";
import { Contract } from "@ethersproject/contracts";
import { TransactionResponse } from "@ethersproject/providers";
import { Wallet } from "@ethersproject/wallet";
import dayjs from "dayjs";

import * as Utils from "./utils";

export type OrderSide = "buy" | "sell";

export interface IEasyAMMPair {
  NewPrice: Utils.Evt<number>;

  base: IEasyERC20;
  quote: IEasyERC20;
  price: number;

  placeOrder(amount: number, side: OrderSide): Promise<TransactionResponse>;
  quotePriceForAmount(amount: number, side: OrderSide): number;
}

export interface IEasyERC20 {
  symbol: string;
  address: string;
  decimals: number;
  balance: number;

  allowance(owner: string, spender: string): Promise<number>;
  approve(spender: string, amount?: number): Promise<TransactionResponse>;
  balanceOf(address: string): Promise<number>;
  transfer(to: string, amount: number): Promise<TransactionResponse>;
}

class EasyERC20 implements IEasyERC20 {
  constructor(
    public symbol: string,
    public address: string,
    public decimals: number,
    public balance: number,
    private _token: Contract
  ) {
    _token.provider.on("block", this.updateBalances.bind(this));
  }

  public async allowance(owner: string, spender: string) {
    const allowance = await this._token.allowance(owner, spender);
    return Utils.fromBigNumber(allowance, this.decimals);
  }

  public approve(spender: string, amount = 0) {
    return this._token.approve(
      spender,
      !amount
        ? "0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff"
        : Utils.toBigNumber(amount, this.decimals)
    );
  }

  public async balanceOf(address: string) {
    const balance = await this._token.balanceOf(address);
    return Utils.fromBigNumber(balance, this.decimals);
  }

  public transfer(to: string, amount: number) {
    return this._token.transfer(to, Utils.toBigNumber(amount, this.decimals));
  }

  private async updateBalances() {
    try {
      this.balance = await this.balanceOf(this._token._wallet.address);
    } catch (err) {
      console.log("error updating price", err);
    }
  }
}

export const createEasyERC20 = async (address: string, wallet: Wallet) => {
  const token = Utils.getERC20(address, wallet.provider);
  const [symbol, decimals, balance] = await Promise.all([
    token.symbol(),
    token.decimals(),
    token.balanceOf(wallet.address),
  ]);

  return new EasyERC20(
    symbol,
    address,
    decimals,
    Utils.fromBigNumber(balance, decimals),
    token
  );
};

class EasyAMMPair implements IEasyAMMPair {
  public NewPrice = new Utils.Evt<number>();

  constructor(
    public base: IEasyERC20,
    public quote: IEasyERC20,
    public price: number,
    private _wallet: Wallet,
    private _router: Contract,
    private _pair: Contract,
    private _reserves: Utils.IReserves,
    private _baseIsFirstToken: boolean,
    private _slippageTolerance: number
  ) {
    _pair.provider.on("block", this.updateData.bind(this));
  }

  public async placeOrder(amount: number, side: OrderSide) {
    const baseAmount = Utils.toBigNumber(amount, this.base.decimals);
    const quoteAmount = Utils.toBigNumber(
      this.quotePriceForAmount(amount, side) * amount,
      this.quote.decimals
    );
    const deadline = dayjs().add(1, "minute").unix();

    let tx;

    if (side === "buy") {
      await this.approve(quoteAmount, this.quote, this._router.address); // TODO: remove this check if already approved

      // amuont out first
      tx = await this._router.populateTransaction.swapTokensForExactTokens(
        baseAmount,
        quoteAmount,
        [this.quote.address, this.base.address],
        this._wallet.address,
        deadline
      );
    } else {
      await this.approve(baseAmount, this.base, this._router.address); // TODO: remove this check if already approved
      // amount in firsy
      tx = await this._router.populateTransaction.swapExactTokensForTokens(
        baseAmount,
        quoteAmount,
        [this.base.address, this.quote.address],
        this._wallet.address,
        deadline
      );
    }

    return this._wallet.sendTransaction(tx);
  }

  public quotePriceForAmount(baseAmount: number, side: OrderSide) {
    const amountWei = Utils.toBigNumber(baseAmount, this.base.decimals);
    if (side === "buy") {
      const amountInWei = Utils.getAmountIn(
        amountWei,
        this._baseIsFirstToken
          ? this._reserves._reserve1
          : this._reserves._reserve0,
        this._baseIsFirstToken
          ? this._reserves._reserve0
          : this._reserves._reserve1
      );

      const amountIn = this.applySlippage(
        Utils.fromBigNumber(amountInWei, this.quote.decimals)
      );

      return amountIn / baseAmount;
    } else {
      const amountOutWei = Utils.getAmountOut(
        amountWei,
        this._baseIsFirstToken
          ? this._reserves._reserve0
          : this._reserves._reserve1,
        this._baseIsFirstToken
          ? this._reserves._reserve1
          : this._reserves._reserve0
      );

      const amountOut = this.applySlippage(
        Utils.fromBigNumber(amountOutWei, this.quote.decimals),
        -1
      );

      return amountOut / baseAmount;
    }
  }

  private async approve(amount: BigNumber, token: IEasyERC20, router: string) {
    const allowance = await token.allowance(this._wallet.address, router);
    if (Utils.toBigNumber(allowance, token.decimals).lt(amount)) {
      const tx = await token.approve(router);
      await tx.wait();
    }
  }

  private applySlippage(amount: number, sign = 1) {
    return amount * (1 + sign * this._slippageTolerance);
  }

  private async updateData() {
    await Promise.all([this.updatePrice()]);
  }

  private async updatePrice() {
    try {
      this._reserves = await this._pair.getReserves();
      this.price = Utils.calcPriceFromReserves(
        this._reserves,
        this._baseIsFirstToken,
        this.base.decimals
      );
      this.NewPrice.trigger(this.price);
    } catch (err) {
      console.log("error updating price", err);
    }
  }
}

export const createEasyAMMPair = async (
  routerAddress: string,
  pairAddress: string,
  base: string,
  wallet: Wallet,
  slippageTolerancePercent = 0.25
) => {
  const router = Utils.getRouter(routerAddress, wallet.provider);
  const pair = Utils.getPair(pairAddress, wallet.provider);

  const [token0, token1, reserves] = await Promise.all([
    pair.token0(),
    pair.token1(),
    pair.getReserves(),
  ]);

  const _token0 = await createEasyERC20(token0, wallet);
  const _token1 = await createEasyERC20(token1, wallet);

  const baseIsFirstToken = base === _token0.symbol;
  const [_base, _quote] = baseIsFirstToken
    ? [_token0, _token1]
    : [_token1, _token0];

  const price = Utils.calcPriceFromReserves(
    reserves,
    baseIsFirstToken,
    _base.decimals
  );

  return new EasyAMMPair(
    _base,
    _quote,
    price,
    wallet,
    router,
    pair,
    reserves,
    baseIsFirstToken,
    slippageTolerancePercent / 100
  );
};
