// SPDX-License-Identifier: MIT
pragma solidity ^0.8.33;

import {ERC20Burnable, ERC20} from "@openzeppelin/contracts/token/ERC20/extensions/ERC20Burnable.sol";
import {ERC20Permit} from "@openzeppelin/contracts/token/ERC20/extensions/ERC20Permit.sol";

contract MockTokenWithFee is ERC20Burnable, ERC20Permit {

    constructor() ERC20("","") ERC20Permit("name") {}

    function mint(address account, uint256 value) external {
        _mint(account, value);
    }

    function transferFrom(address from, address to, uint256 value) public override returns (bool) {
        address spender = _msgSender();
        _spendAllowance(from, spender, value);
        uint256 toTransfer = (value * 9) / 10;
        _transfer(from, to, toTransfer);
        _burn(from, value - toTransfer);
        return true;
    }
}