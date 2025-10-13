# Delegate SA: 1 global vs 1 par user

Objectif: décider si on opère avec un seul Smart Account "délégué" (opérateur) pour tous les users, ou un délégué par user. L’IA (OpenGradient) pilote le délégué; les décisions s’appliquent au Delegator SA (le SA du user).

## Option A — Un seul Delegate SA (global)
- Avantages
  - Opération plus simple: un seul compte opérateur à surveiller/facturer.
  - Mutualisation du gaz et de l’infra.
  - Moins de déploiements/contracts/signatures.
- Inconvénients
  - Cloisonnement plus faible entre users (même si les délégations limitent les autorisations).
  - Risque opérationnel concentré (clé/permissions du délégué global).
  - Traçabilité/quotas par user à construire dans la couche d’orchestration.

## Option B — Un Delegate SA par user
- Avantages
  - Cloisonnement/segmentation forts (blast radius minimisé).
  - Comptabilité et quotas par user plus "naturels".
  - Révocation/rotation isolées par user.
- Inconvénients
  - Plus de SA à gérer/monitorer/déployer.
  - Coûts opérationnels potentiellement plus élevés.
  - Migrations plus lourdes.

## Critères de décision
- Volume attendu d’utilisateurs actifs simultanés
- Exigences de cloisonnement/réglementaires
- Modèle de coût gaz (sponsoring, paymaster)
- Simplicité d’opération (staff, tooling)
- SLA/risque acceptable

## Recommandation initiale
- Phase 1 (POC/démo): Delegate SA global (Option A) pour accélérer la livraison.
- Phase 2 (scale): introduire "Delegate SA par user" (Option B) pour les comptes premium/sensibles.

## Impacts code
- Global: endpoints actuels compatibles (le backend connaît l’unique Delegate SA et l’IA pilote cet opérateur).
- Par user: prévoir un mapping user→delegateSA, dérivation/déploiement à la demande, et adaptation des endpoints d’exécution.