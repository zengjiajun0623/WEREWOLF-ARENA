// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {WerewolfGame} from "./WerewolfGame.sol";

contract GameFactory {
    address public owner;
    address public relay;
    address public feeRecipient;

    uint256 public nextGameId;
    mapping(uint256 => address) public games;

    // Leaderboard
    mapping(address => uint256) public wins;
    mapping(address => uint256) public losses;
    mapping(address => uint256) public gamesPlayed;

    event GameCreated(uint256 indexed gameId, address game);
    event RelayUpdated(address oldRelay, address newRelay);

    error OnlyOwner();
    error NoRelay();

    modifier onlyOwner() {
        if (msg.sender != owner) revert OnlyOwner();
        _;
    }

    constructor(address _relay, address _feeRecipient) {
        owner = msg.sender;
        relay = _relay;
        feeRecipient = _feeRecipient;
    }

    function createGame() external returns (uint256 gameId, address game) {
        if (relay == address(0)) revert NoRelay();

        gameId = nextGameId++;
        WerewolfGame wg = new WerewolfGame();
        wg.initialize(gameId, relay, feeRecipient);

        games[gameId] = address(wg);
        emit GameCreated(gameId, address(wg));

        return (gameId, address(wg));
    }

    function recordResult(
        uint256 gameId,
        address[] calldata winners,
        address[] calldata losers
    ) external {
        require(msg.sender == relay, "only relay");
        require(games[gameId] != address(0), "game not found");

        for (uint256 i = 0; i < winners.length; i++) {
            wins[winners[i]]++;
            gamesPlayed[winners[i]]++;
        }
        for (uint256 i = 0; i < losers.length; i++) {
            losses[losers[i]]++;
            gamesPlayed[losers[i]]++;
        }
    }

    function setRelay(address _relay) external onlyOwner {
        emit RelayUpdated(relay, _relay);
        relay = _relay;
    }

    function setFeeRecipient(address _feeRecipient) external onlyOwner {
        feeRecipient = _feeRecipient;
    }

    function setOwner(address _owner) external onlyOwner {
        owner = _owner;
    }

    function getStats(address player) external view returns (uint256, uint256, uint256) {
        return (wins[player], losses[player], gamesPlayed[player]);
    }
}
