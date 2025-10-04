// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

// Minimal interface expected by Delegation Toolkit style enforcers
// (You will need to adapt function signature names to actual DTK expectations if different.)
interface IEnforcer {
    function beforeExecute(bytes calldata terms, bytes calldata callData, address target, uint256 value) external view;
}

/**
 * @title ValueTransferEnforcer
 * @notice Authorise transferts de MON natif (value) vers une liste de destinataires whitelists
 *         avec limites par tx et plafond cumulé.
 * @dev Terms encoding (abi.encode(Terms))
 */
contract ValueTransferEnforcer is IEnforcer {
    struct Terms {
        address[] recipients;   // adresses autorisées
        uint256 maxPerTx;       // montant max par transfert
        uint256 cap;            // plafond cumulatif autorisé (optionnel: hors scope ici sans state)
    }

    error RecipientNotAllowed();
    error ValueTooHigh();
    error NoValue();
    error InvalidTerms();

    // Stateless: ne comptabilise pas le cumul (cap informatif ou à faire via un enforcer stateful séparé)
    function beforeExecute(
        bytes calldata terms,
        bytes calldata /*callData*/,
        address target,
        uint256 value
    ) external view override {
        if (value == 0) revert NoValue();
        Terms memory t = _decode(terms);
        bool allowed = false;
        for (uint256 i; i < t.recipients.length; i++) {
            if (t.recipients[i] == target) { allowed = true; break; }
        }
        if (!allowed) revert RecipientNotAllowed();
        if (t.maxPerTx > 0 && value > t.maxPerTx) revert ValueTooHigh();
        // cap ignoré ici (stateless) -> si besoin stateful, ajouter stockage + accumulateur
    }

    function _decode(bytes calldata b) internal pure returns (Terms memory t) {
        // Expect abi.encode(Terms)
        if (b.length < 96) revert InvalidTerms();
        (address[] memory recips, uint256 maxPerTx, uint256 cap) = abi.decode(b, (address[], uint256, uint256));
        t.recipients = recips;
        t.maxPerTx = maxPerTx;
        t.cap = cap;
    }
}
