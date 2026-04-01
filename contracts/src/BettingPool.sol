// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {WerewolfGame} from "./WerewolfGame.sol";

contract BettingPool {
    struct Pool {
        uint256 totalVillagerBets;
        uint256 totalWerewolfBets;
        bool resolved;
        WerewolfGame.Side winningSide;
    }

    struct Bet {
        WerewolfGame.Side side;
        uint256 amount;
        bool claimed;
    }

    address public relay;
    uint256 public constant MIN_BET = 0.0001 ether;
    uint256 public constant FEE_BPS = 300; // 3%
    address public feeRecipient;

    // gameId => Pool
    mapping(uint256 => Pool) public pools;
    // gameId => bettor => Bet
    mapping(uint256 => mapping(address => Bet)) public bets;

    event BetPlaced(uint256 indexed gameId, address indexed bettor, WerewolfGame.Side side, uint256 amount);
    event PoolResolved(uint256 indexed gameId, WerewolfGame.Side winningSide);
    event WinningsClaimed(uint256 indexed gameId, address indexed bettor, uint256 amount);

    error BetTooSmall();
    error InvalidSide();
    error AlreadyBet();
    error PoolAlreadyResolved();
    error PoolNotResolved();
    error NoBet();
    error AlreadyClaimed();
    error NotWinner();
    error OnlyRelay();

    modifier onlyRelay() {
        if (msg.sender != relay) revert OnlyRelay();
        _;
    }

    constructor(address _relay, address _feeRecipient) {
        relay = _relay;
        feeRecipient = _feeRecipient;
    }

    function bet(uint256 gameId, WerewolfGame.Side side) external payable {
        if (msg.value < MIN_BET) revert BetTooSmall();
        if (side != WerewolfGame.Side.Villagers && side != WerewolfGame.Side.Werewolves) revert InvalidSide();
        if (bets[gameId][msg.sender].amount > 0) revert AlreadyBet();
        if (pools[gameId].resolved) revert PoolAlreadyResolved();

        bets[gameId][msg.sender] = Bet({side: side, amount: msg.value, claimed: false});

        if (side == WerewolfGame.Side.Villagers) {
            pools[gameId].totalVillagerBets += msg.value;
        } else {
            pools[gameId].totalWerewolfBets += msg.value;
        }

        emit BetPlaced(gameId, msg.sender, side, msg.value);
    }

    function resolve(uint256 gameId, WerewolfGame.Side winningSide) external onlyRelay {
        if (pools[gameId].resolved) revert PoolAlreadyResolved();

        pools[gameId].resolved = true;
        pools[gameId].winningSide = winningSide;

        // Take protocol fee from total pool
        uint256 totalPool = pools[gameId].totalVillagerBets + pools[gameId].totalWerewolfBets;
        if (totalPool > 0) {
            uint256 fee = (totalPool * FEE_BPS) / 10000;
            if (fee > 0) {
                (bool success,) = feeRecipient.call{value: fee}("");
                require(success, "fee transfer failed");
            }
        }

        emit PoolResolved(gameId, winningSide);
    }

    function claim(uint256 gameId) external {
        if (!pools[gameId].resolved) revert PoolNotResolved();

        Bet storage userBet = bets[gameId][msg.sender];
        if (userBet.amount == 0) revert NoBet();
        if (userBet.claimed) revert AlreadyClaimed();
        if (userBet.side != pools[gameId].winningSide) revert NotWinner();

        userBet.claimed = true;

        uint256 totalPool = pools[gameId].totalVillagerBets + pools[gameId].totalWerewolfBets;
        uint256 fee = (totalPool * FEE_BPS) / 10000;
        uint256 distributablePool = totalPool - fee;

        uint256 winningSideTotal;
        if (pools[gameId].winningSide == WerewolfGame.Side.Villagers) {
            winningSideTotal = pools[gameId].totalVillagerBets;
        } else {
            winningSideTotal = pools[gameId].totalWerewolfBets;
        }

        // Proportional payout
        uint256 payout = (userBet.amount * distributablePool) / winningSideTotal;

        (bool success,) = msg.sender.call{value: payout}("");
        require(success, "payout failed");

        emit WinningsClaimed(gameId, msg.sender, payout);
    }

    function getPool(uint256 gameId) external view returns (uint256 villagerBets, uint256 werewolfBets, bool resolved) {
        Pool storage pool = pools[gameId];
        return (pool.totalVillagerBets, pool.totalWerewolfBets, pool.resolved);
    }
}
