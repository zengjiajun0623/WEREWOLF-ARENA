// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Test.sol";
import {GameFactory} from "../src/GameFactory.sol";
import {WerewolfGame} from "../src/WerewolfGame.sol";
import {BettingPool} from "../src/BettingPool.sol";

contract WerewolfGameTest is Test {
    GameFactory factory;
    BettingPool betting;
    address relay = makeAddr("relay");
    address feeRecipient = makeAddr("feeRecipient");

    address[] agents;

    function setUp() public {
        factory = new GameFactory(relay, feeRecipient);
        betting = new BettingPool(relay, feeRecipient);

        for (uint256 i = 0; i < 7; i++) {
            agents.push(makeAddr(string(abi.encodePacked("agent", vm.toString(i)))));
            vm.deal(agents[i], 1 ether);
        }
    }

    function _createAndFillGame() internal returns (uint256 gameId, WerewolfGame game) {
        (gameId,) = factory.createGame();
        game = WerewolfGame(factory.games(gameId));

        for (uint256 i = 0; i < 7; i++) {
            vm.prank(agents[i]);
            game.join{value: 0.001 ether}();
        }
    }

    function test_createGame() public {
        (uint256 gameId, address gameAddr) = factory.createGame();
        assertEq(gameId, 0);
        assertTrue(gameAddr != address(0));

        WerewolfGame game = WerewolfGame(gameAddr);
        assertEq(uint256(game.state()), uint256(WerewolfGame.GameState.Waiting));
    }

    function test_joinGame() public {
        (uint256 gameId,) = factory.createGame();
        WerewolfGame game = WerewolfGame(factory.games(gameId));

        vm.prank(agents[0]);
        game.join{value: 0.001 ether}();

        assertEq(game.playerCount(), 1);
        assertTrue(game.isPlayer(agents[0]));
    }

    function test_joinGame_wrongFee() public {
        (uint256 gameId,) = factory.createGame();
        WerewolfGame game = WerewolfGame(factory.games(gameId));

        vm.prank(agents[0]);
        vm.expectRevert(WerewolfGame.WrongEntryFee.selector);
        game.join{value: 0.002 ether}();
    }

    function test_joinGame_alreadyJoined() public {
        (uint256 gameId,) = factory.createGame();
        WerewolfGame game = WerewolfGame(factory.games(gameId));

        vm.prank(agents[0]);
        game.join{value: 0.001 ether}();

        vm.prank(agents[0]);
        vm.expectRevert(WerewolfGame.AlreadyJoined.selector);
        game.join{value: 0.001 ether}();
    }

    function test_gameStartsWhenFull() public {
        (, WerewolfGame game) = _createAndFillGame();
        assertEq(uint256(game.state()), uint256(WerewolfGame.GameState.Active));
        assertEq(game.playerCount(), 7);
    }

    function test_settle_villagersWin() public {
        (uint256 gameId, WerewolfGame game) = _createAndFillGame();

        // Villagers win: agents 0-4 win, agents 5-6 are werewolves
        address[] memory winners = new address[](5);
        address[] memory losers = new address[](2);
        WerewolfGame.Role[] memory roles = new WerewolfGame.Role[](7);

        for (uint256 i = 0; i < 5; i++) {
            winners[i] = agents[i];
            roles[i] = i == 4 ? WerewolfGame.Role.Seer : WerewolfGame.Role.Villager;
        }
        losers[0] = agents[5];
        losers[1] = agents[6];
        roles[5] = WerewolfGame.Role.Werewolf;
        roles[6] = WerewolfGame.Role.Werewolf;

        bytes32 txHash = keccak256("transcript");

        uint256 feeRecipientBefore = feeRecipient.balance;

        vm.prank(relay);
        game.settle(winners, losers, roles, txHash);

        assertEq(uint256(game.state()), uint256(WerewolfGame.GameState.Finished));

        // Total pool = 0.007 ETH, protocol fee = 5% = 0.00035 ETH
        // Winner pool = 0.00665 ETH, per winner = 0.00133 ETH
        uint256 feeReceived = feeRecipient.balance - feeRecipientBefore;
        assertEq(feeReceived, 0.00035 ether);

        // Each winner should have received ~0.00133 ether
        // (with rounding, last winner gets dust)
        for (uint256 i = 0; i < 4; i++) {
            assertGt(agents[i].balance, 0.999 ether); // started with 1, paid 0.001, received ~0.00133
        }
    }

    function test_settle_onlyRelay() public {
        (, WerewolfGame game) = _createAndFillGame();

        address[] memory winners = new address[](1);
        address[] memory losers = new address[](6);
        WerewolfGame.Role[] memory roles = new WerewolfGame.Role[](7);
        winners[0] = agents[0];
        for (uint256 i = 1; i < 7; i++) losers[i - 1] = agents[i];

        vm.prank(agents[0]);
        vm.expectRevert(WerewolfGame.OnlyRelay.selector);
        game.settle(winners, losers, roles, bytes32(0));
    }

    function test_betting_flow() public {
        (, WerewolfGame game) = _createAndFillGame();

        address bettor1 = makeAddr("bettor1");
        address bettor2 = makeAddr("bettor2");
        vm.deal(bettor1, 1 ether);
        vm.deal(bettor2, 1 ether);

        // Place bets
        vm.prank(bettor1);
        betting.bet{value: 0.01 ether}(0, WerewolfGame.Side.Villagers);

        vm.prank(bettor2);
        betting.bet{value: 0.01 ether}(0, WerewolfGame.Side.Werewolves);

        // Resolve: villagers win
        vm.prank(relay);
        betting.resolve(0, WerewolfGame.Side.Villagers);

        // Bettor1 claims winnings
        uint256 before = bettor1.balance;
        vm.prank(bettor1);
        betting.claim(0);

        // Should receive total pool minus 3% fee
        // Total = 0.02, fee = 0.0006, distributable = 0.0194
        // Bettor1 bet all of villager side, gets all distributable
        uint256 received = bettor1.balance - before;
        assertEq(received, 0.0194 ether);

        // Bettor2 cannot claim (lost)
        vm.prank(bettor2);
        vm.expectRevert(BettingPool.NotWinner.selector);
        betting.claim(0);
    }

    function test_betting_noBetBeforeResolve() public {
        address bettor = makeAddr("bettor");
        vm.deal(bettor, 1 ether);

        vm.prank(bettor);
        betting.bet{value: 0.01 ether}(0, WerewolfGame.Side.Villagers);

        // Can't claim before resolution
        vm.prank(bettor);
        vm.expectRevert(BettingPool.PoolNotResolved.selector);
        betting.claim(0);
    }
}
