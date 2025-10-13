/**
 * Script pour vérifier les délégations et identifier le problème du Delegate SA partagé
 */
import { readFileSync, existsSync, readdirSync } from 'fs';
import { join } from 'path';
import { keccak256 } from 'viem';

const DELEGATIONS_DIR = join(process.cwd(), 'data', 'delegations');

interface DelegationInfo {
  delegatorSA: string;
  delegateSA: string;
  file: string;
  expectedDelegateSA: string;
  isCorrect: boolean;
}

function computeExpectedDelegateSA(delegatorSA: string): string {
  // Calculer le salt basé sur le Delegator SA
  const salt = keccak256(`0x${delegatorSA.slice(2).padStart(64, '0')}`);
  console.log(`\n[Debug] Delegator: ${delegatorSA}`);
  console.log(`[Debug] Computed salt: ${salt}`);
  
  // NOTE: Le calcul de l'adresse du Delegate SA dépend de la factory et des paramètres de déploiement
  // Pour l'instant, on retourne juste le salt pour montrer le problème
  return `Would be different with salt: ${salt}`;
}

async function checkDelegations() {
  console.log('🔍 Checking delegations...\n');

  if (!existsSync(DELEGATIONS_DIR)) {
    console.log('❌ Delegations directory not found');
    return;
  }

  const files = readdirSync(DELEGATIONS_DIR).filter(f => f.endsWith('.json') && !f.includes('__'));
  
  console.log(`Found ${files.length} core delegations:\n`);

  const delegations: DelegationInfo[] = [];

  for (const file of files) {
    try {
      const content = readFileSync(join(DELEGATIONS_DIR, file), 'utf8');
      const data = JSON.parse(content);
      
      const delegatorSA = data.delegatorSA;
      const delegateSA = data.signedDelegation?.delegation?.delegate;
      
      if (!delegatorSA || !delegateSA) {
        console.log(`⚠️  ${file}: Missing data`);
        continue;
      }

      const expectedDelegateSA = computeExpectedDelegateSA(delegatorSA);
      
      delegations.push({
        delegatorSA,
        delegateSA,
        file,
        expectedDelegateSA,
        isCorrect: false, // On ne peut pas vraiment calculer sans connaître tous les paramètres
      });

    } catch (e: any) {
      console.log(`❌ Error reading ${file}: ${e.message}`);
    }
  }

  // Analyser les résultats
  console.log('\n📋 Delegation Analysis:\n');
  console.log('═'.repeat(120));
  console.log('File'.padEnd(50), 'Delegator SA'.padEnd(45), 'Delegate SA');
  console.log('═'.repeat(120));

  for (const d of delegations) {
    console.log(d.file.padEnd(50), d.delegatorSA.padEnd(45), d.delegateSA);
  }

  console.log('═'.repeat(120));

  // Vérifier les duplications de Delegate SA
  const delegateSACount = new Map<string, string[]>();
  for (const d of delegations) {
    const list = delegateSACount.get(d.delegateSA) || [];
    list.push(d.delegatorSA);
    delegateSACount.set(d.delegateSA, list);
  }

  console.log('\n🚨 Delegate SA Usage:\n');
  
  let hasDuplicates = false;
  for (const [delegateSA, delegators] of delegateSACount.entries()) {
    if (delegators.length > 1) {
      hasDuplicates = true;
      console.log(`❌ PROBLEM: Delegate SA ${delegateSA} is used by ${delegators.length} Delegators:`);
      delegators.forEach((d, i) => {
        console.log(`   ${i + 1}. ${d} ${i === 0 ? '✅ (works)' : '❌ (reverts)'}`);
      });
      console.log();
    } else {
      console.log(`✅ OK: Delegate SA ${delegateSA} used by 1 Delegator: ${delegators[0]}`);
    }
  }

  if (hasDuplicates) {
    console.log('\n🔧 SOLUTION REQUIRED:\n');
    console.log('Each Delegator SA must have its own unique Delegate SA.');
    console.log('This is done by using a unique deploySalt based on the Delegator SA address.\n');
    console.log('Current code uses:');
    console.log('  deploySalt: "0x"  ❌ (same for everyone)\n');
    console.log('Should use:');
    console.log('  deploySalt: keccak256(`0x${delegatorSA.slice(2).padStart(64,"0")}`)  ✅ (unique per Delegator)\n');
  } else {
    console.log('\n✅ No duplicate Delegate SA found. System is correctly configured.\n');
  }

  console.log('\n📊 Summary:\n');
  console.log(`Total Delegations: ${delegations.length}`);
  console.log(`Unique Delegate SAs: ${delegateSACount.size}`);
  console.log(`Status: ${hasDuplicates ? '❌ NEEDS FIX' : '✅ OK'}\n`);
}

checkDelegations().catch(console.error);
