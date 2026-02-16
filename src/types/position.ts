export interface PaperPosition {
  userId: string;
  asset: number;
  coin: string;
  szi: string;        // signed size (positive = long, negative = short)
  entryPx: string;
  leverage: number;
  marginType: 'cross' | 'isolated';
  cumFunding: string;
  cumFundingSinceOpen: string;
  cumFundingSinceChange: string;
}

export interface UserAccount {
  userId: string;
  apiKey: string;
  balance: string;
  createdAt: number;
}

export interface LeverageSetting {
  leverage: number;
  isCross: boolean;
}
