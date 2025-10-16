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
import dotenv from 'dotenv';

// Charger les variables d'environnement
dotenv.config();

// Configuration
const CHAIN_ID = 10143;
const RPC_URL = process.env.VITE_RPC_URL || 'https://rpc.ankr.com/monad_testnet';

// Adresses des contrats Monad Testnet
const USDC = '0xf817257fed379853cDe0fa4F97AB987181B1E5Ea';
const UNISWAP_V2_ROUTER02 = '0xfb8e1c3b833f9e67a71c859a132cf783b645e436';
const WMON = '0x760AfE86e5de5fa0Ee542fc7B7B713e1c5425701';

async function createTestDelegation() {
  console.log('🚀 Création d\'une délégation de test...\n');
  
  try {
    // 1. Client RPC avec définition de chaîne
    const monadTestnet = {
      id: CHAIN_ID,
      name: 'Monad Testnet',
      nativeCurrency: { name: 'Monad', symbol: 'MON', decimals: 18 },
      rpcUrls: {
        default: { http: [RPC_URL] },
        public: { http: [RPC_URL] },
      },
      blockExplorers: {
        default: { name: 'Monad Explorer', url: 'https://testnet.monadexplorer.com' },
      },
    };
    
    const publicClient = createPublicClient({
      chain: monadTestnet,
      transport: http(RPC_URL)
    });
    
    // 2. Clé privée du délégué
    const delegatePrivateKey = process.env.VITE_DELEGATE_PRIVATE_KEY;
    if (!delegatePrivateKey) {
      throw new Error('❌ VITE_DELEGATE_PRIVATE_KEY manquante dans .env');
    }
    
    const delegateEOA = privateKeyToAccount(delegatePrivateKey);
    console.log('👤 Delegate EOA:', delegateEOA.address);
    
    // 3. Environnement DTK
    const env = getDeleGatorEnvironment(CHAIN_ID);
    console.log('🌍 DelegationManager:', env.DelegationManager);
    
    // 4. Smart Account du délégué
    const delegateSA = await toMetaMaskSmartAccount({
      client: publicClient,
      implementation: Implementation.Hybrid,
      deployParams: [delegateEOA.address, [], [], []],
      deploySalt: '0x',
      signer: { account: delegateEOA },
      environment: env,
    });
    
    console.log('🏦 Delegate SA:', delegateSA.address);
    
    // 5. Générer une adresse utilisateur de test
    const testUserPrivateKey = '0x' + '1'.repeat(64); // Clé de test
    const testUserEOA = privateKeyToAccount(testUserPrivateKey);
    
    // 6. Smart Account de l'utilisateur (delegator)
    const userSA = await toMetaMaskSmartAccount({
      client: publicClient,
      implementation: Implementation.Hybrid,
      deployParams: [testUserEOA.address, [], [], []],
      deploySalt: '0x',
      signer: { account: testUserEOA },
      environment: env,
    });
    
    console.log('👨‍💼 User EOA (test):', testUserEOA.address);
    console.log('🏛️  User SA (delegator):', userSA.address);
    
    // 7. Cibles autorisées (incluant le SA utilisateur)
    const allowedTargets = [
      USDC,                    // USDC token
      UNISWAP_V2_ROUTER02,     // Uniswap router
      WMON,                    // WMON token
      userSA.address,          // Le SA lui-même (pour recevoir)
      testUserEOA.address,     // L'EOA (pour les transferts natifs)
    ];
    
    // 8. Sélecteurs de fonctions autorisés
    const allowedSelectors = [
      // ERC20 standard
      getFunctionSelector('approve(address,uint256)'),
      getFunctionSelector('transfer(address,uint256)'),
      getFunctionSelector('transferFrom(address,address,uint256)'),
      
      // Uniswap V2
      getFunctionSelector('swapExactTokensForTokens(uint256,uint256,address[],address,uint256)'),
      getFunctionSelector('swapTokensForExactTokens(uint256,uint256,address[],address,uint256)'),
      getFunctionSelector('swapExactETHForTokens(uint256,address[],address,uint256)'),
      getFunctionSelector('swapExactTokensForETH(uint256,uint256,address[],address,uint256)'),
      
      // WETH/WMON
      getFunctionSelector('withdraw(uint256)'),
      getFunctionSelector('deposit()'),
      
      // EIP-2612 Permit
      getFunctionSelector('permit(address,address,uint256,uint256,uint8,bytes32,bytes32)'),
      
      // EIP-3009
      getFunctionSelector('transferWithAuthorization(address,address,uint256,uint256,uint256,bytes32,uint8,bytes32,bytes32)'),
    ];
    
    console.log('\n📋 Configuration:');
    console.log('  - Targets autorisées:', allowedTargets.length);
    console.log('  - Sélecteurs autorisés:', allowedSelectors.length);
    
    // 9. Création de la délégation
    const delegation = createOpenDelegation({
      environment: env,
      from: userSA.address,  // Le delegator (utilisateur)
      scope: {
        type: 'functionCall',
        targets: allowedTargets,
        selectors: allowedSelectors,
      },
    });
    
    // 10. Signature de test (en réalité, signée par l'utilisateur)
    const testSignature = await userSA.signDelegation({ delegation });
    
    console.log('\n✍️  Délégation signée');
    
    // 11. Structure complète pour le backend
    const delegationFile = {
      signedDelegation: {
        delegation,
        signature: testSignature,
      },
      job: {
        amountUSDC: '1',           // 1 USDC par swap
        slippageBps: 100,          // 1% slippage
        intervalSec: 60,           // Toutes les 60 secondes
        durationSec: 24 * 60 * 60, // 24 heures
        unwrapEvery: 1,            // Unwrap à chaque fois
        unwrapToMon: true,         // Convertir WMON → MON
        usePaymaster: true,        // Utiliser le paymaster
        ownerEOA: testUserEOA.address,
        createdAtMs: Date.now(),
        runCounter: 0,
        dailyTopupUSDC: 24,        // 24 USDC max par jour
        topupUsed: false,
      },
    };
    
    // 12. Sauvegarde
    const filename = `${userSA.address.toLowerCase()}.json`;
    const dirPath = path.join(process.cwd(), 'data', 'delegations');
    const filePath = path.join(dirPath, filename);
    
    // Créer le dossier s'il n'existe pas
    fs.mkdirSync(dirPath, { recursive: true });
    
    // Écrire le fichier
    fs.writeFileSync(filePath, JSON.stringify(delegationFile, null, 2));
    
    console.log('\n✅ Délégation créée avec succès!');
    console.log('📁 Fichier:', filePath);
    console.log('\n📊 Résumé:');
    console.log('  - Delegator SA:', userSA.address);
    console.log('  - Delegate SA:', delegateSA.address);
    console.log('  - User EOA:', testUserEOA.address);
    console.log('  - Delegate EOA:', delegateEOA.address);
    
    console.log('\n🎯 Targets autorisées:');
    allowedTargets.forEach((target, i) => {
      const name = target === USDC ? 'USDC' : 
                   target === UNISWAP_V2_ROUTER02 ? 'Router' :
                   target === WMON ? 'WMON' :
                   target === userSA.address ? 'User SA' :
                   target === testUserEOA.address ? 'User EOA' : 'Unknown';
      console.log(`    ${i + 1}. ${name}: ${target}`);
    });
    
    console.log('\n🔧 Pour tester:');
    console.log('  1. Déployez le Smart Account utilisateur');
    console.log('  2. Envoyez des USDC au SA utilisateur');
    console.log('  3. Lancez le runner avec cette délégation');
    
    return {
      delegatorSA: userSA.address,
      delegateSA: delegateSA.address,
      userEOA: testUserEOA.address,
      delegateEOA: delegateEOA.address,
      filePath,
    };
    
  } catch (error) {
    console.error('\n❌ Erreur lors de la création:', error.message);
    if (error.stack) {
      console.error('Stack:', error.stack);
    }
    throw error;
  }
}

// Exécution
createTestDelegation()
  .then(result => {
    console.log('\n🎉 Terminé avec succès!');
    process.exit(0);
  })
  .catch(error => {
    console.error('\n💥 Échec:', error.message);
    process.exit(1);
  });
