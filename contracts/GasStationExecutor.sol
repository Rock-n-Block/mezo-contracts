// SPDX-License-Identifier: MIT
pragma solidity ^0.8.33;

import {EIP712Upgradeable} from "@openzeppelin/contracts-upgradeable/utils/cryptography/EIP712Upgradeable.sol";
import {AccessControlUpgradeable} from "@openzeppelin/contracts-upgradeable/access/AccessControlUpgradeable.sol";
import {PausableUpgradeable} from "@openzeppelin/contracts-upgradeable/utils/PausableUpgradeable.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {IERC20Permit} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Permit.sol";
import {SafeERC20, IERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

contract GasStationExecutor is EIP712Upgradeable, AccessControlUpgradeable, PausableUpgradeable {
    using SafeERC20 for IERC20;

    bytes32 public constant RELAYER_ROLE = keccak256("RELAYER_ROLE");

    bytes32 private constant SWAP_DATA_TYPEHASH = keccak256("SwapData(address executionContract,string functionSignature,bytes executionCalldata,address outputToken,address receiver,uint256 inputAmount,uint256 minAmountOut)");
    bytes32 private constant EXECUTE_SWAP_TYPEHASH = keccak256("ExecuteSwap(address token,SwapData swapData,uint256 feeAmount,uint256 nonce,uint256 deadline)SwapData(address executionContract,string functionSignature,bytes executionCalldata,address outputToken,address receiver,uint256 inputAmount,uint256 minAmountOut)");

    mapping(address => uint256) public userNonce;
    mapping(address => mapping(bytes4 => bool)) public whitelistedSelectors;

    struct PermitInfo {
        bool required;
        uint256 value;
        uint256 deadline;
        uint8 v;
        bytes32 r;
        bytes32 s;
    }

    struct SwapData {
        address executionContract;
        string functionSignature;
        bytes executionCalldata;
        IERC20 outputToken;
        address receiver;
        uint256 inputAmount;
        uint256 minAmountOut;
    }

    struct FeeSwapData {
        address executionContract;
        bytes4 functionSelector;
        bytes executionCalldata;
        uint256 inputAmount;
    }

    error DeadlinePassed(uint256 deadline, uint256 currentTime);
    error InvalidSignature();
    error InvalidFunctionCall(address executionContract, bytes4 selector);
    error SwapFailed(bool isFeeSwap, bytes returnData);
    error LowBalance(address checkedAddress, IERC20 token, uint256 balance, uint256 expectedBalance);
    error NonMatchingLength(uint256 lengthOne, uint256 lengthTwo, uint256 lengthThree);

    event SwapExecuted(address indexed user, uint256 indexed nonce, IERC20 token, SwapData swapData, FeeSwapData feeSwapData);
    event SelectorWhitelistStatusSet(address[] executionContract, bytes4[] selector, bool[] whitelisted);

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    /**
     * @notice initializer
     * @dev contract starts paused when initialized
     */
    function initialize(address admin, address[] calldata relayer) external initializer {
        __EIP712_init("GasStationExecutor", "1");
        __AccessControl_init();
        __Pausable_init();
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        for (uint256 i; i < relayer.length; i++) {
            _grantRole(RELAYER_ROLE, relayer[i]);
        }
        _pause();
    }

    /**
     * @notice allows to perform gasless swap
     * @dev affected by pause
     * @param user address from which input token will be taken
     * @param token input token
     * @param permitInfo struct containing necessary information for managing ERC20Permit permit() call
     * @param swapData struct containing necessary information for managing user swap
     * @param feeSwapData struct containing necessary information for managing fee swap
     * @param deadline signature and execution deadline
     * @param signature EIP712 signature for ExecuteSwap struct
     */
    function executeSwap(address user, IERC20 token, PermitInfo calldata permitInfo, SwapData calldata swapData, FeeSwapData calldata feeSwapData, uint256 deadline, bytes calldata signature) external onlyRole(RELAYER_ROLE) whenNotPaused {
        require(deadline >= block.timestamp, DeadlinePassed(deadline, block.timestamp));
        require(
            user == ECDSA.recover(_hashTypedDataV4(
                keccak256(abi.encode(
                    EXECUTE_SWAP_TYPEHASH,
                    token,
                    _hashSwapData(swapData),
                    feeSwapData.inputAmount,
                    _increaseNonce(user),
                    deadline
                ))
            ), signature), InvalidSignature()
        );

        if (permitInfo.required) {
            IERC20Permit(address(token)).permit(
                user,
                address(this),
                permitInfo.value,
                permitInfo.deadline,
                permitInfo.v,
                permitInfo.r,
                permitInfo.s
            );
        }

        uint256 balance = token.balanceOf(address(this));

        token.safeTransferFrom(user, address(this), swapData.inputAmount + feeSwapData.inputAmount);

        uint256 receiverBalance = _getBalance(swapData.outputToken, swapData.receiver);

        token.approve(swapData.executionContract, swapData.inputAmount);
        _doSwap(
            swapData.executionContract,
            bytes4(keccak256(bytes(swapData.functionSignature))),
            swapData.executionCalldata,
            false
        );

        uint256 currentBalance = _getBalance(swapData.outputToken, swapData.receiver);
        require(
            currentBalance >= receiverBalance + swapData.minAmountOut,
            LowBalance(
                swapData.receiver,
                swapData.outputToken,
                currentBalance,
                receiverBalance + swapData.minAmountOut
            )
        );

        currentBalance = token.balanceOf(address(this));
        if (currentBalance > (balance + feeSwapData.inputAmount)) {
            token.safeTransfer(user, currentBalance - (balance + feeSwapData.inputAmount));
        }

        currentBalance = token.balanceOf(address(this));
        require(
            currentBalance >= balance + feeSwapData.inputAmount,
            LowBalance(
                address(this),
                token,
                currentBalance,
                balance + feeSwapData.inputAmount
            )
        );

        token.approve(feeSwapData.executionContract, feeSwapData.inputAmount);
        _doSwap(
            feeSwapData.executionContract,
            feeSwapData.functionSelector,
            feeSwapData.executionCalldata,
            true
        );

        // userNonce[user] - 1 because _increaseNonce(user) is required above to avoid stack too deep error
        emit SwapExecuted(user, userNonce[user] - 1, token, swapData, feeSwapData);
    }

    /**
     * @notice pauses contract, disabling executeSwap() calls
     */
    function pause() external onlyRole(DEFAULT_ADMIN_ROLE) {
        _pause();
    }

    /**
     * @notice unpauses contract, enabling executeSwap() calls
     */
    function unpause() external onlyRole(DEFAULT_ADMIN_ROLE) {
        _unpause();
    }

    /**
     * @notice allows to set validity of external function calls during executeSwap()
     */
    function setWhitelistedSelectors(address[] calldata executionContract, bytes4[] calldata selector, bool[] calldata whitelisted) external onlyRole(DEFAULT_ADMIN_ROLE) {
        require(
            executionContract.length == selector.length && executionContract.length == whitelisted.length,
            NonMatchingLength(executionContract.length, selector.length, whitelisted.length)
        );
        for (uint256 i; i < executionContract.length; i++) {
            whitelistedSelectors[executionContract[i]][selector[i]] = whitelisted[i];
        }
        emit SelectorWhitelistStatusSet(executionContract, selector, whitelisted);
    }

    /**
     * @notice allows to transfer ERC20 token stuck on this contract
     */
    function getToken(IERC20 token, address receiver, uint256 value) external onlyRole(DEFAULT_ADMIN_ROLE) {
        token.safeTransfer(receiver, value);
    }

    // made to avoid stack too deep error
    function _hashSwapData(SwapData calldata swapData) private pure returns(bytes32) {
        return keccak256(abi.encode(
            SWAP_DATA_TYPEHASH,
            swapData.executionContract,
            keccak256(bytes(swapData.functionSignature)),
            keccak256(swapData.executionCalldata),
            swapData.outputToken,
            swapData.receiver,
            swapData.inputAmount,
            swapData.minAmountOut
        ));
    }

    // made to avoid stack too deep error
    function _increaseNonce(address user) private returns(uint256) {
        return userNonce[user]++;
    }

    function _getBalance(IERC20 token, address user) private view returns(uint256) {
        if (address(token) == 0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE) {
            return user.balance;
        }
        else {
            return token.balanceOf(user);
        }
    }

    function _doSwap(address executionContract, bytes4 selector, bytes calldata executionCalldata, bool isFeeSwap) private {
        require(whitelistedSelectors[executionContract][selector], InvalidFunctionCall(executionContract, selector));
        (bool success, bytes memory returnData) = executionContract.call(bytes.concat(selector, executionCalldata));
        require(success, SwapFailed(isFeeSwap, returnData));
    }
}