// SPDX-License-Identifier: MIT
pragma solidity ^0.8.14;

import {IERC1155} from "../interfaces/IERC1155.sol";

/**
 * @title LowLevelERC1155Transfer
 * @notice This contract contains low-level calls to transfer ERC1155 tokens.
 * @author LooksRare protocol team (👀,💎)
 */
contract LowLevelERC1155Transfer {
    error ERC1155SafeTransferFromFail();
    error ERC1155SafeBatchTransferFrom();

    /**
     * @notice Execute ERC1155 safeTransferFrom
     * @param collection Address of the collection
     * @param from Address of the sender
     * @param to Address of the recipient
     * @param tokenId tokenId to transfer
     * @param amount Amount to transfer
     */
    function _executeERC1155SafeTransferFrom(
        address collection,
        address from,
        address to,
        uint256 tokenId,
        uint256 amount
    ) internal {
        (bool status, ) = collection.call(
            abi.encodeWithSelector(IERC1155.safeTransferFrom.selector, from, to, tokenId, amount, "")
        );

        if (!status) revert ERC1155SafeTransferFromFail();
    }

    /**
     * @notice Execute ERC1155 safeBatchTransferFrom
     * @param collection Address of the collection
     * @param from Address of the sender
     * @param to Address of the recipient
     * @param tokenIds Array of tokenIds to transfer
     * @param amounts Array of amounts to transfer
     */
    function _executeERC1155SafeBatchTransferFrom(
        address collection,
        address from,
        address to,
        uint256[] calldata tokenIds,
        uint256[] calldata amounts
    ) internal {
        (bool status, ) = collection.call(
            abi.encodeWithSelector(IERC1155.safeBatchTransferFrom.selector, from, to, tokenIds, amounts, "")
        );

        if (!status) revert ERC1155SafeBatchTransferFrom();
    }
}
