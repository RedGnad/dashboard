#!/usr/bin/env node

import { privateKeyToAccount } from 'viem/accounts';
import { createPublicClient, http, getFunctionSelector } from 'viem';
import { 
  Implementation, 
  toMetaMaskSmartAccount, 
  createOpenDelegation, 
  getDeleGatorEnvironment 
} from '@metamask/delegation-toolkit';
import fs from 'fs';
import path from 'path';

// Configuration Monad Testnet
const CHAIN_ID = 10143;
const RPC_URL = 'https://rpc.ankr.com/monad_testnet';

// Adresses des contrats
const USDC = '0xf817257fed379853cDe0fa4F97AB987181B1E5Ea';
const UNISWAP_V2_ROUTER02 = '0xfb8e1c3b833f9e67a71c859a132cf783b645e436';
const WMON = '0x760AfE86e5de5fa0Ee542fc7B7B713e1c5425701';

async function createDelegation() {
  try {
    console.log('🔧 Création de la délégation...');
    
    // 1. Configuration du client
    const publicClient = createPublicClient({
      transport: http(RPC_URL)
    });
    
    // 2. Récupération de la clé privée
    const pk = process.env.VITE_DELEGATE_PRIVATE_KEY;
    if (!pk) {
      throw new Error('VITE_DELEGATE_PRIVATE_KEY manquante dans .env');
    }
    
    const delegateEOA = privateKeyToAccount(pk);
    console.log('👤 Delegate EOA:', delegateEOA.address);
    
    // 3. Environnement DelegationToolkit
    const env = getDeleGatorEnvironment(CHAIN_ID);
    console.log('🌍 Environment:', {
      DelegationManager: env.DelegationManager,
      chainId: CHAIN_ID
    });
    
    // 4. Création du Smart Account du délégué
    const delegateSA = await toMetaMaskSmartAccount({
      client: publicClient,
      implementation: Implementation.Hybrid,
      deployParams: [delegateEOA.address, [], [], []],
      deploySalt: '0x',
      signer: { account: delegateEOA },
      environment: env,
    });
    
    console.log('🏦 Delegate Smart Account:', delegateSA.address);
    
    // 5. Simulation d'un utilisateur (vous devrez remplacer par la vraie adresse)
    // Pour l'instant, on utilise une adresse d'exemple
    const userEOA = '0x742d35Cc6634C0532925a3b8D4f6e5c7B8c9e8D2'; // À remplacer
    
    const userSA = await toMetaMaskSmartAccount({
      client: publicClient,
      implementation: Implementation.Hybrid,
      deployParams: [userEOA, [], [], []],
      deploySalt: '0x',
      signer: { account: delegateEOA }, // Temporaire pour la dérivation
      environment: env,
    });
    
    console.log('👨‍💼 User Smart Account (exemple):', userSA.address);
    
    // 6. Définition des cibles autorisées
    const allowedTargets = [
      USDC,                    // Pour approve/transferFrom
      UNISWAP_V2_ROUTER02,     // Pour swap
      WMON,                    // Pour withdraw/deposit
      userSA.address,          // Pour recevoir les tokens
    ];
    
    // 7. Définition des sélecteurs autorisés
    const allowedSelectors = [
      getFunctionSelector('approve(address,uint256)'),
      getFunctionSelector('transfer(address,uint256)'),
      getFunctionSelector('transferFrom(address,address,uint256)'),
      getFunctionSelector('swapExactTokensForTokens(uint256,uint256,address[],address,uint256)'),
      getFunctionSelector('withdraw(uint256)'),
      getFunctionSelector('deposit()'),
      getFunctionSelector('permit(address,address,uint256,uint256,uint8,bytes32,bytes32)'),
      getFunctionSelector('transferWithAuthorization(address,address,uint256,uint256,uint256,bytes32,uint8,bytes32,bytes32)'),
    ];
    
    console.log('🎯 Targets autorisées:', allowedTargets.length);
    console.log('⚡ Sélecteurs autorisés:', allowedSelectors.length);
    
    // 8. Création de la délégation
    const delegation = createOpenDelegation({
      environment: env,
      from: userSA.address,
      scope: {
        type: 'functionCall',
        targets: allowedTargets,
        selectors: allowedSelectors,
      },
    });
    
    console.log('📝 Délégation créée:', {
      delegator: delegation.delegator,
      delegate: delegation.delegate,
      authority: delegation.authority,
      caveats: delegation.caveats?.length || 0,
    });
    
    // 9. Signature (simulation - en réalité fait côté client)
    const signature = '0x' + '00'.repeat(65); // Signature placeholder
    
    // 10. Structure complète de la délégation
    const delegationData = {
      signedDelegation: {
        delegation,
        signature,
      },
      job: {
        amountUSDC: '1',
        slippageBps: 100,
        intervalSec: 60,
        durationSec: 24 * 60 * 60,
        unwrapEvery: 1,
        unwrapToMon: true,
        usePaymaster: true,
        ownerEOA: userEOA,
        createdAtMs: Date.now(),
        runCounter: 0,
      },
    };
    
    // 11. Sauvegarde
    const filename = `${userSA.address.toLowerCase()}.json`;
    const filepath = path.join('data', 'delegations', filename);
    
    fs.writeFileSync(filepath, JSON.stringify(delegationData, null, 2));
    
    console.log('✅ Délégation sauvegardée:', filepath);
    console.log('📋 Résumé:');
    console.log('  - Delegator SA:', userSA.address);
    console.log('  - Delegate SA:', delegateSA.address);
    console.log('  - Targets:', allowedTargets.length);
    console.log('  - Selectors:', allowedSelectors.length);
    
    return {
      delegatorSA: userSA.address,
      delegateSA: delegateSA.address,
      filepath,
    };
    
  } catch (error) {
    console.error('❌ Erreur:', error.message);
    throw error;
  }
}

// Exécution si appelé directement
if (import.meta.url === `file://${process.argv[1]}`) {
  createDelegation()
    .then(result => {
      console.log('🎉 Délégation créée avec succès!');
      process.exit(0);
    })
    .catch(error => {
      console.error('💥 Échec de la création:', error);
      process.exit(1);
    });
}

export { createDelegation };
