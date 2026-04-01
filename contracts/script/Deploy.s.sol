// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Script.sol";
import {GameFactory} from "../src/GameFactory.sol";
import {BettingPool} from "../src/BettingPool.sol";

contract Deploy is Script {
    function run() external {
        address relay = vm.envAddress("RELAY_ADDRESS");
        address feeRecipient = vm.envAddress("FEE_RECIPIENT");

        vm.startBroadcast();

        GameFactory factory = new GameFactory(relay, feeRecipient);
        BettingPool betting = new BettingPool(relay, feeRecipient);

        vm.stopBroadcast();

        console.log("GameFactory deployed at:", address(factory));
        console.log("BettingPool deployed at:", address(betting));
        console.log("Relay:", relay);
        console.log("Fee Recipient:", feeRecipient);
    }
}
