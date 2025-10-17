import React from 'react';
import { ConnectKitButton } from 'connectkit';

export default function WalletButton() {
  return (
    <div className="fixed top-6 right-6 z-40">
      <ConnectKitButton />
    </div>
  );
}
