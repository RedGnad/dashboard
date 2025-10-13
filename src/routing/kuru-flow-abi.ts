export const kuruFlowEntrypointAbi = [
  {
    name: 'executeSwap',
    type: 'function',
    stateMutability: 'payable',
    inputs: [
      {
        components: [
          { name: 'tokenUserBuys', type: 'address' },
          { name: 'minAmountUserBuys', type: 'uint256' },
          { name: 'tokenUserSells', type: 'address' },
          { name: 'amountUserSells', type: 'uint256' }
        ],
        name: 'swapIntent',
        type: 'tuple'
      },
      {
        components: [
          { name: 'feeCollectorAddress', type: 'address' },
          { name: 'feeBps', type: 'uint256' },
          { name: 'referrerAddress', type: 'address' },
          { name: 'referrerFeeBps', type: 'uint256' },
          { name: 'isInTokenFee', type: 'bool' }
        ],
        name: 'feeCollection',
        type: 'tuple'
      },
      { name: 'program', type: 'bytes' }
    ],
    outputs: [{ name: 'amountOut', type: 'uint256' }]
  },
  {
    name: 'executeSwapWithReceiver',
    type: 'function',
    stateMutability: 'payable',
    inputs: [
      {
        components: [
          { name: 'tokenUserBuys', type: 'address' },
          { name: 'minAmountUserBuys', type: 'uint256' },
          { name: 'tokenUserSells', type: 'address' },
          { name: 'amountUserSells', type: 'uint256' }
        ],
        name: 'swapIntent',
        type: 'tuple'
      },
      {
        components: [
          { name: 'feeCollectorAddress', type: 'address' },
          { name: 'feeBps', type: 'uint256' },
          { name: 'referrerAddress', type: 'address' },
          { name: 'referrerFeeBps', type: 'uint256' },
          { name: 'isInTokenFee', type: 'bool' }
        ],
        name: 'feeCollection',
        type: 'tuple'
      },
      { name: 'program', type: 'bytes' },
      { name: 'receiver', type: 'address' }
    ],
    outputs: [{ name: 'amountOut', type: 'uint256' }]
  }
] as const;