// Official caveat enforcer addresses (version 0.13.0 changelog)
// NOTE: Keep in lowercase for comparisons.
export const ENFORCERS = {
  AllowedCalldataEnforcer: '0xc2b0d624c1c4319760c96503ba27c347f3260f55',
  AllowedMethodsEnforcer: '0x2c21fd0cb9dc8445cb3fb0dc5e7bb0aca01842b5',
  AllowedTargetsEnforcer: '0x7f20f61b1f09b08d970938f6fa563634d65c4eeb',
  ArgsEqualityCheckEnforcer: '0x44b8c6ae3c304213c3e298495e12497ed3e56e41',
  BlockNumberEnforcer: '0x5d9818df0ae3f66e9c3d0c5029daf99d1823ca6c',
  DeployedEnforcer: '0x24ff2aa430d53a8cd6788018e902e098083dccd2',
  ERC20BalanceChangeEnforcer: '0xcdf6ab796408598cea671d79506d7d48e97a5437',
  ERC20TransferAmountEnforcer: '0xf100b0819427117ecf76ed94b358b1a5b5c6d2fc',
  ERC20PeriodTransferEnforcer: '0x474e3ae7e169e940607cc624da8a15eb120139ab',
  ERC20StreamingEnforcer: '0x56c97ae02f233b29fa03502ecc0457266d9be00e',
  ERC721BalanceChangeEnforcer: '0x8afdf96edbbe7e1ed3f5cd89c7e084841e12a09e',
  ERC721TransferEnforcer: '0x3790e6b7233f779b09da74c72b6e94813925b9af',
  ERC1155BalanceChangeEnforcer: '0x63c322732695cafbbd488fc6937a0a7b66fc001a',
  ExactCalldataBatchEnforcer: '0x982fd5c86bbf425d7d1451f974192d4525113dfd',
  ExactCalldataEnforcer: '0x99f2e9bf15ce5ec84685604836f71ab835dbbded',
  ExactExecutionBatchEnforcer: '0x1e141e455d08721dd5bcdaa1baa6ea5633afd5017',
  ExactExecutionEnforcer: '0x146713078d39ecc1f5338309c28405ccf85abfbb',
  IdEnforcer: '0xc8b5d93463c893401094cc70e66a206fb5987997',
  LimitedCallsEnforcer: '0x04658b29f6b82ed55274221a06fc97d318e25416',
  MultiTokenPeriodEnforcer: '0xfb2f1a9bd76d3701b730e5d69c3219d42d80ebb7',
  NonceEnforcer: '0xde4f2fac4b3d87a1d9953ca5fc09fca7f366254f',
  NativeBalanceChangeEnforcer: '0xbd7b277507723490cd50b12eaafe87c616be6880',
  NativeTokenPaymentEnforcer: '0x4803a326dded6ddbc60e659e5ed12d85c7582811',
  NativeTokenTransferAmountEnforcer: '0xf71af580b9c3078fbc2bbf16fbb8eed82b330320',
  NativeTokenStreamingEnforcer: '0xd10b97905a320b13a0608f7e9cc506b56747df19',
  NativeTokenPeriodTransferEnforcer: '0x9bc0faf4aca5ae429f4c06aeecac517520cb16bd9',
  OwnershipTransferEnforcer: '0x7eef9734e7092032b5c56310eb9bbd1f4a524681',
  RedeemerEnforcer: '0xe144b0b2618071b4e56f746313528a669c7e65c5',
  SpecificActionERC20TransferBatchEnforcer: '0x00e0251aaa263dfe3b3541b758a82d1cba1c3b6d',
  TimestampEnforcer: '0x1046bb45c8d673d4ea75321280db34899413c069',
  ValueLteEnforcer: '0x92bf12322527caa612fd31a0e810472bbb106a8f'
} as const

export type EnforcerName = keyof typeof ENFORCERS

export function findEnforcerName(address: string): EnforcerName | undefined {
  const a = address.toLowerCase()
  return (Object.keys(ENFORCERS) as EnforcerName[]).find((k) => ENFORCERS[k] === a)
}
