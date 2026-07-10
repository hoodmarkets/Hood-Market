// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {HoodMarketsAsciiBanner} from "../HoodMarketsAsciiBanner.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {ERC20Burnable} from "@openzeppelin/contracts/token/ERC20/extensions/ERC20Burnable.sol";
import {ERC20Permit} from "@openzeppelin/contracts/token/ERC20/extensions/ERC20Permit.sol";
import {ERC20Votes} from "@openzeppelin/contracts/token/ERC20/extensions/ERC20Votes.sol";
import {Nonces} from "@openzeppelin/contracts/utils/Nonces.sol";

/// @notice hood.markets V3 launch token (Robinhood-only ERC20; no SuperChain bridge).
contract HoodMarketsV3Token is ERC20, ERC20Permit, ERC20Votes, ERC20Burnable {
    error NotAdmin();
    error AlreadyVerified();

    address private _admin;
    string private _metadata;
    string private _context;
    string private _image;
    bool private _verified;

    event Verified(address indexed admin, address indexed token);
    event UpdateImage(string image);
    event UpdateMetadata(string metadata);

    constructor(
        string memory name_,
        string memory symbol_,
        uint256 maxSupply_,
        address admin_,
        string memory image_,
        string memory metadata_,
        string memory context_,
        uint256 initialSupplyChainId_
    ) ERC20(name_, symbol_) ERC20Permit(name_) {
        _admin = admin_;
        _image = image_;
        _metadata = metadata_;
        _context = context_;

        if (block.chainid == initialSupplyChainId_) {
            _mint(msg.sender, maxSupply_);
        }
    }

    function updateImage(string memory image_) external {
        if (msg.sender != _admin) revert NotAdmin();
        _image = image_;
        emit UpdateImage(image_);
    }

    function updateMetadata(string memory metadata_) external {
        if (msg.sender != _admin) revert NotAdmin();
        _metadata = metadata_;
        emit UpdateMetadata(metadata_);
    }

    function _update(address from, address to, uint256 value)
        internal
        override(ERC20, ERC20Votes)
    {
        super._update(from, to, value);
    }

    function verify() external {
        if (msg.sender != _admin) revert NotAdmin();
        if (_verified) revert AlreadyVerified();
        _verified = true;
        emit Verified(msg.sender, address(this));
    }

    function isVerified() external view returns (bool) {
        return _verified;
    }

    function nonces(address owner) public view override(ERC20Permit, Nonces) returns (uint256) {
        return super.nonces(owner);
    }

    function admin() external view returns (address) {
        return _admin;
    }

    function imageUrl() external view returns (string memory) {
        return _image;
    }

    function metadata() external view returns (string memory) {
        return _metadata;
    }

    function context() external view returns (string memory) {
        return _context;
    }
}
