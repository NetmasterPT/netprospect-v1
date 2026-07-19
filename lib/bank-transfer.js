// lib/bank-transfer.js — transferência bancária (dados de payout). Trivial: expõe
// IBAN/BIC/titular do env. Fail-soft: bankTransferEnabled().
import { loadEnv } from './env.js';
loadEnv();

export function getBankTransferConfig() {
  const iban = process.env.BANK_TRANSFER_IBAN || '';
  const bic = process.env.BANK_TRANSFER_BIC || '';
  const accountHolder = process.env.BANK_TRANSFER_ACCOUNT_HOLDER || '';
  if (!iban) throw new Error('Transferência bancária não configurada: falta BANK_TRANSFER_IBAN.');
  return { iban, bic, accountHolder };
}
export function bankTransferEnabled() { try { getBankTransferConfig(); return true; } catch { return false; } }
export const isBankTransferConfigured = bankTransferEnabled;

// Instruções de pagamento (o caso de uso — email/PDF — fica para a feature).
export function paymentInstructions(reference) {
  const c = getBankTransferConfig();
  return { iban: c.iban, bic: c.bic, accountHolder: c.accountHolder, reference: reference || null };
}
