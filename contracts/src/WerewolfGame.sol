// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

contract WerewolfGame {
    enum Role { Villager, Werewolf, Seer }
    enum GameState { Waiting, Active, Finished }
    enum Side { None, Villagers, Werewolves }

    struct GameResult {
        Side winningSide;
        bytes32 transcriptHash; // IPFS hash of full transcript
        uint256 settledAt;
    }

    uint256 public constant ENTRY_FEE = 0.001 ether;
    uint256 public constant MAX_PLAYERS = 7;
    uint256 public constant PROTOCOL_FEE_BPS = 500; // 5%

    address public immutable factory;
    address public relay;
    uint256 public gameId;

    address[] public players;
    mapping(address => bool) public isPlayer;
    mapping(address => Role) public roles;
    mapping(address => bool) public isAlive;

    GameState public state;
    GameResult public result;

    address public protocolFeeRecipient;

    event PlayerJoined(uint256 indexed gameId, address indexed player, uint256 playerCount);
    event GameStarted(uint256 indexed gameId, address[] players);
    event GameSettled(uint256 indexed gameId, Side winningSide, address[] winners, bytes32 transcriptHash);

    error GameNotWaiting();
    error GameNotActive();
    error AlreadyJoined();
    error WrongEntryFee();
    error GameFull();
    error OnlyRelay();
    error InvalidSettlement();

    modifier onlyRelay() {
        if (msg.sender != relay) revert OnlyRelay();
        _;
    }

    constructor() {
        factory = msg.sender;
    }

    function initialize(uint256 _gameId, address _relay, address _feeRecipient) external {
        require(msg.sender == factory, "only factory");
        gameId = _gameId;
        relay = _relay;
        protocolFeeRecipient = _feeRecipient;
        state = GameState.Waiting;
    }

    function join() external payable {
        if (state != GameState.Waiting) revert GameNotWaiting();
        if (isPlayer[msg.sender]) revert AlreadyJoined();
        if (msg.value != ENTRY_FEE) revert WrongEntryFee();
        if (players.length >= MAX_PLAYERS) revert GameFull();

        players.push(msg.sender);
        isPlayer[msg.sender] = true;
        isAlive[msg.sender] = true;

        emit PlayerJoined(gameId, msg.sender, players.length);

        if (players.length == MAX_PLAYERS) {
            state = GameState.Active;
            emit GameStarted(gameId, players);
        }
    }

    function settle(
        address[] calldata winners,
        address[] calldata losers,
        Role[] calldata _roles,
        bytes32 transcriptHash
    ) external onlyRelay {
        if (state != GameState.Active) revert GameNotActive();
        if (winners.length + losers.length != players.length) revert InvalidSettlement();
        if (_roles.length != players.length) revert InvalidSettlement();

        // Store roles
        for (uint256 i = 0; i < players.length; i++) {
            roles[players[i]] = _roles[i];
        }

        // Determine winning side from first winner's role
        Side winningSide;
        if (_roles[_indexOf(winners[0])] == Role.Werewolf) {
            winningSide = Side.Werewolves;
        } else {
            winningSide = Side.Villagers;
        }

        result = GameResult({
            winningSide: winningSide,
            transcriptHash: transcriptHash,
            settledAt: block.timestamp
        });
        state = GameState.Finished;

        // Distribute prizes
        uint256 totalPool = ENTRY_FEE * MAX_PLAYERS;
        uint256 protocolFee = (totalPool * PROTOCOL_FEE_BPS) / 10000;
        uint256 winnerPool = totalPool - protocolFee;
        uint256 perWinner = winnerPool / winners.length;

        // Pay protocol fee
        (bool feeSuccess,) = protocolFeeRecipient.call{value: protocolFee}("");
        require(feeSuccess, "fee transfer failed");

        // Pay winners
        for (uint256 i = 0; i < winners.length; i++) {
            (bool success,) = winners[i].call{value: perWinner}("");
            require(success, "winner transfer failed");
        }

        // Send any dust to last winner
        uint256 dust = address(this).balance;
        if (dust > 0) {
            (bool dustSuccess,) = winners[winners.length - 1].call{value: dust}("");
            require(dustSuccess, "dust transfer failed");
        }

        emit GameSettled(gameId, winningSide, winners, transcriptHash);
    }

    function getPlayers() external view returns (address[] memory) {
        return players;
    }

    function playerCount() external view returns (uint256) {
        return players.length;
    }

    function _indexOf(address player) internal view returns (uint256) {
        for (uint256 i = 0; i < players.length; i++) {
            if (players[i] == player) return i;
        }
        revert("player not found");
    }
}
