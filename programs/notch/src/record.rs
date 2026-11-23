use anchor_lang::prelude::*;

use crate::NotchError;

/// Must match enclave/src/record.js byte for byte.
/// "NOTCHv2\0" | wallet[32] | limit_micro u64 | expiry i64 | dedupe[32] | nonce u64 | id_hash[32]  (little endian)
/// `id_hash` is sha256("notch-msisdn"|number) (optionally peppered) for statement-backed records and
/// all zeros when the source has no bindable identity.
pub const TAG: &[u8; 8] = b"NOTCHv2\0";
pub const RECORD_LEN: usize = 128;

pub struct Record {
    pub wallet: Pubkey,
    pub limit: u64,
    pub expiry: i64,
    pub dedupe: [u8; 32],
    pub nonce: u64,
    pub id_hash: [u8; 32],
}

impl Record {
    pub fn parse(b: &[u8]) -> Result<Self> {
        require!(
            b.len() == RECORD_LEN && &b[..8] == TAG,
            NotchError::BadRecord
        );
        let u64_at = |i: usize| u64::from_le_bytes(b[i..i + 8].try_into().unwrap());
        Ok(Self {
            wallet: Pubkey::new_from_array(b[8..40].try_into().unwrap()),
            limit: u64_at(40),
            expiry: u64_at(48) as i64,
            dedupe: b[56..88].try_into().unwrap(),
            nonce: u64_at(88),
            id_hash: b[96..128].try_into().unwrap(),
        })
    }
}

/// Parse a native Ed25519 program instruction and return (pubkey, message) for its single signature.
/// All offsets must point inside this same instruction (index u16::MAX), so nothing can be smuggled
/// in from another instruction.
pub fn ed25519_pubkey_and_message(data: &[u8]) -> Result<(Pubkey, Vec<u8>)> {
    require!(data.len() >= 16 && data[0] == 1, NotchError::BadSigIx);
    let u16_at = |i: usize| u16::from_le_bytes([data[i], data[i + 1]]);
    let (sig_off, sig_ix) = (u16_at(2) as usize, u16_at(4));
    let (pk_off, pk_ix) = (u16_at(6) as usize, u16_at(8));
    let (msg_off, msg_len, msg_ix) = (u16_at(10) as usize, u16_at(12) as usize, u16_at(14));
    require!(
        sig_ix == u16::MAX && pk_ix == u16::MAX && msg_ix == u16::MAX,
        NotchError::BadSigIx
    );
    require!(
        sig_off + 64 <= data.len() && pk_off + 32 <= data.len(),
        NotchError::BadSigIx
    );
    require!(msg_off + msg_len <= data.len(), NotchError::BadSigIx);
    let pk = Pubkey::new_from_array(data[pk_off..pk_off + 32].try_into().unwrap());
    Ok((pk, data[msg_off..msg_off + msg_len].to_vec()))
}
