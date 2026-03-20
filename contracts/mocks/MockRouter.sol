// SPDX-License-Identifier: MIT
pragma solidity ^0.8.33;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

contract MockRouter {

    error Reverted();

    receive() external payable {}

    function mockSwap(IERC20 inputToken, IERC20 outputToken, address receiver, uint256 inputAmount, uint256 outputAmount) external {
        inputToken.transferFrom(msg.sender, address(this), inputAmount);
        if (address(outputToken) == 0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE) {
            receiver.call{value: outputAmount}("");
        }
        else {
            outputToken.transfer(receiver, outputAmount);
        }
    }

    function anotherFunction(bool shouldRevert) external pure {
        if (shouldRevert) {
            revert Reverted();
        }
    }
}