#!/bin/bash

# Script pour corriger le deploySalt dans server.ts

echo "🔧 Fixing deploySalt in server.ts..."

FILE="src/server.ts"
BACKUP="src/server.ts.backup.$(date +%Y%m%d_%H%M%S)"

# Backup
echo "📦 Creating backup: $BACKUP"
cp "$FILE" "$BACKUP"

# Les modifications à faire manuellement
echo ""
echo "⚠️  MODIFICATIONS À FAIRE MANUELLEMENT"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""
echo "Ouvrez src/server.ts et cherchez les lignes suivantes :"
echo ""
echo "1️⃣  Dans /api/unwrap (ligne ~3620) :"
echo "   AVANT: deploySalt: '0x',"
echo "   APRÈS: deploySalt: (keccak256(\`0x\${(delegatorSA as string).slice(2).padStart(64,'0')}\`) as \`0x\${string}\`),"
echo ""
echo "2️⃣  Dans /api/flush (ligne ~3830) :"
echo "   AVANT: deploySalt: '0x',"
echo "   APRÈS: deploySalt: (keccak256(\`0x\${(delegatorSA as string).slice(2).padStart(64,'0')}\`) as \`0x\${string}\`),"
echo ""
echo "3️⃣  Dans /api/wrap (ligne ~4040) :"
echo "   AVANT: deploySalt: '0x',"
echo "   APRÈS: deploySalt: (keccak256(\`0x\${(delegatorSA as string).slice(2).padStart(64,'0')}\`) as \`0x\${string}\`),"
echo ""
echo "4️⃣  Dans /api/send-mon (chercher 'send-mon') :"
echo "   AVANT: deploySalt: '0x',"
echo "   APRÈS: deploySalt: (keccak256(\`0x\${(delegatorSA as string).slice(2).padStart(64,'0')}\`) as \`0x\${string}\`),"
echo ""
echo "⚠️  NE PAS MODIFIER :"
echo "   - /api/delegate (ligne ~2516) → Doit rester deploySalt: '0x'"
echo "   - /api/topup (ligne ~3917) → Doit rester deploySalt: '0x'"
echo ""
echo "📝 Un backup a été créé : $BACKUP"
echo ""
echo "Après les modifications :"
echo "1. npm run build"
echo "2. npm run api:stop && npm run api:start"
echo "3. Re-créer les délégations depuis l'UI"
echo "4. npx tsx check-delegations.ts (pour vérifier)"
