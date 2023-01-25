import { JsonRpcProvider } from "@ethersproject/providers";
import { config } from "dotenv";

import * as EasyAMM from "./easy-amm";
import * as Utils from "./utils";

config();

// TODO: handle when want to trade with wrapped native token - EasyAMMWrappedPair maybe?
// TODO: handle multi pair swap i.e path.length > 2

const PROVIDER_URL = process.env.PROVIDER_URL;
const MNEMONIC = process.env.MNEMONIC;

const provider = new JsonRpcProvider(PROVIDER_URL || "");
const wallet = Utils.AutoNonceWallet.fromMnemonic(
  MNEMONIC || "",
  "m/44'/60'/0'/0/0"
).connect(provider);

async function main() {
  const pair = await EasyAMM.createEasyAMMPair(
    "0x10ED43C718714eb63d5aA57B78B54704E256024E",
    "0x2ed957a5180bacfc93f4b8790cb59e304514eec6",
    "DCB",
    wallet
  );

  console.log(pair.quotePriceForAmount(1000, "buy"));
  console.log(pair.quotePriceForAmount(100000, "buy"));
  console.log(pair.quotePriceForAmount(10000000, "buy"));
  console.log(pair.quotePriceForAmount(1000, "sell"));
  console.log(pair.quotePriceForAmount(100000, "sell"));
  console.log(pair.quotePriceForAmount(10000000, "sell"));

  // pair.placeOrder(1000, "buy").then((tx) => console.log("TX HASH:", tx.hash));
}

main();
