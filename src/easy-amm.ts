import { Contract } from "@ethersproject/contracts";
import { TransactionResponse } from "@ethersproject/providers";
import { Wallet } from "@ethersproject/wallet";
import { formatUnits, parseUnits } from "@ethersproject/units";
import dayjs from "dayjs";

import * as Utils from "./utils";
import { BigNumber } from "@ethersproject/bignumber";

export type OrderSide = "buy" | "sell";

export interface IEasyAMMPair {
  NewPrice: Utils.Evt<number>;

  base: string;
  quote: string;
  baseBal: number;
  quoteBal: number;
  price: number;

  placeOrder(amount: number, side: OrderSide): Promise<TransactionResponse>;
  quotePriceForAmount(amount: number, side: OrderSide): number;
}

class EasyAMMPair implements IEasyAMMPair {
  public NewPrice = new Utils.Evt<number>();

  constructor(
    public base: string,
    public quote: string,
    public baseBal: number,
    public quoteBal: number,
    public price: number,
    private _wallet: Wallet,
    private _router: Contract,
    private _pair: Contract,
    private _reserves: Utils.IReserves,
    private _baseAddress: string,
    private _quoteAddress: string,
    private _baseDecimals: number,
    private _quoteDecimals: number,
    private _baseIsFirstToken: boolean,
    private _slippageTolerance: number
  ) {
    _pair.provider.on("block", this.updateData.bind(this));
  }

  public async placeOrder(amount: number, side: OrderSide) {
    const baseAmount = parseUnits(amount.toString(), this._baseDecimals);
    const quoteAmount = parseUnits(
      (this.quotePriceForAmount(amount, side) * amount).toString(),
      this._quoteDecimals
    );
    const deadline = dayjs().add(1, "minute").unix();

    let tx;

    if (side === "buy") {
      await this.approve(quoteAmount, this._quoteAddress, this._router.address);

      // amuont out first
      tx = await this._router.populateTransaction.swapTokensForExactTokens(
        baseAmount,
        quoteAmount,
        [this._quoteAddress, this._baseAddress],
        this._wallet.address,
        deadline
      );
    } else {
      await this.approve(baseAmount, this._baseAddress, this._router.address);
      // amount in firsy
      tx = await this._router.populateTransaction.swapExactTokensForTokens(
        baseAmount,
        quoteAmount,
        [this._baseAddress, this._quoteAddress],
        this._wallet.address,
        deadline
      );
    }

    return this._wallet.sendTransaction(tx);
  }

  public quotePriceForAmount(baseAmount: number, side: OrderSide) {
    const amountWei = parseUnits(baseAmount.toString(), this._baseDecimals);
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
        parseFloat(formatUnits(amountInWei, this._quoteDecimals))
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
        parseFloat(formatUnits(amountOutWei, this._quoteDecimals)),
        -1
      );

      return amountOut / baseAmount;
    }
  }

  private async approve(amount: BigNumber, token_addr: string, router: string) {
    const token = Utils.getERC20(token_addr, this._wallet.provider);
    const allowance = await token.allowance(this._wallet.address, router);
    if (allowance.lt(amount)) {
      const tx = await token.populateTransaction.approve(
        router,
        "0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff"
      );
      const res = await this._wallet.sendTransaction(tx);
      await res.wait();
    }
  }

  private applySlippage(amount: number, sign = 1) {
    return amount * (1 + sign * this._slippageTolerance);
  }

  private async updateData() {
    await Promise.all([this.updatePrice(), this.updateBalances()]);
  }

  private async updateBalances() {
    try {
      this._reserves = await this._pair.getReserves();
      this.price = Utils.calcPriceFromReserves(
        this._reserves,
        this._baseIsFirstToken,
        this._baseDecimals
      );
      this.NewPrice.trigger(this.price);
    } catch (err) {
      console.log("error updating price", err);
    }
  }

  private async updatePrice() {
    try {
      const [base, quote] = await Promise.all([
        Utils.getERC20(this._baseAddress, this._wallet.provider).balanceOf(
          this._wallet.address
        ),
        Utils.getERC20(this._quoteAddress, this._wallet.provider).balanceOf(
          this._wallet.address
        ),
      ]);

      this.baseBal = parseFloat(formatUnits(base, this._baseDecimals));
      this.quoteBal = parseFloat(formatUnits(quote, this._quoteDecimals));
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

  const _token0 = Utils.getERC20(token0, wallet.provider);
  const _token1 = Utils.getERC20(token1, wallet.provider);

  const [symbol0, symbol1, decimals0, decimals1, bal0, bal1] =
    await Promise.all([
      _token0.symbol(),
      _token1.symbol(),
      _token0.decimals(),
      _token1.decimals(),
      _token0.balanceOf(wallet.address),
      _token1.balanceOf(wallet.address),
    ]);

  const baseIsFirstToken = base === symbol0;

  const price = Utils.calcPriceFromReserves(
    reserves,
    baseIsFirstToken,
    baseIsFirstToken ? decimals0 : decimals1
  );

  return new EasyAMMPair(
    baseIsFirstToken ? symbol0 : symbol1,
    baseIsFirstToken ? symbol1 : symbol0,
    parseFloat(
      formatUnits(
        baseIsFirstToken ? bal0 : bal1,
        baseIsFirstToken ? decimals0 : decimals1
      )
    ),
    parseFloat(
      formatUnits(
        baseIsFirstToken ? bal1 : bal0,
        baseIsFirstToken ? decimals1 : decimals0
      )
    ),
    price,
    wallet,
    router,
    pair,
    reserves,
    baseIsFirstToken ? token0 : token1,
    baseIsFirstToken ? token1 : token0,
    baseIsFirstToken ? decimals0 : decimals1,
    baseIsFirstToken ? decimals1 : decimals0,
    baseIsFirstToken,
    slippageTolerancePercent / 100
  );
};
