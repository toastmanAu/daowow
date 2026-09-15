//! Absolute epoch `since` rules from CKB RFC-0017. `since` is a lower bound,
//! never evidence that a transaction was included before an upper deadline.
use crate::CoreError;

pub const MAX_EPOCH_NUMBER: u64 = 0x00ff_ffff;
pub const ABSOLUTE_EPOCH_FLAG: u64 = 0x2000_0000_0000_0000;

pub fn absolute_epoch_number(since: u64) -> Result<u64, CoreError> {
    if since >> 56 != 0x20 {
        return Err(CoreError::InvalidArgument);
    }
    let index = (since >> 24) & 0xffff;
    let length = (since >> 40) & 0xffff;
    if !(index < length || (index == 0 && length == 0)) {
        return Err(CoreError::InvalidArgument);
    }
    Ok(since & MAX_EPOCH_NUMBER)
}

pub fn absolute_epoch_at_least(since: u64, deadline: u64) -> Result<(), CoreError> {
    if deadline > MAX_EPOCH_NUMBER || absolute_epoch_number(since)? < deadline {
        return Err(CoreError::StateTransition);
    }
    Ok(())
}

pub fn absolute_epoch_since(number: u64) -> Result<u64, CoreError> {
    if number > MAX_EPOCH_NUMBER {
        return Err(CoreError::InvalidArgument);
    }
    Ok(ABSOLUTE_EPOCH_FLAG | number)
}

/// Require a complete configured DAO term from the deposit inclusion epoch.
/// Epoch fractions are compared by cross multiplication, not packed bits.
pub fn absolute_epoch_after_dao_term(
    since: u64,
    deposit_epoch: u64,
    periods: u32,
) -> Result<(), CoreError> {
    if deposit_epoch >> 56 != 0 || periods == 0 {
        return Err(CoreError::InvalidArgument);
    }
    let deposit_number = absolute_epoch_number(ABSOLUTE_EPOCH_FLAG | deposit_epoch)?;
    let target = deposit_number
        .checked_add(u64::from(periods) * 180)
        .filter(|target| *target <= MAX_EPOCH_NUMBER)
        .ok_or(CoreError::Overflow)?;
    let number = absolute_epoch_number(since)?;
    let index = (since >> 24) & 0xffff;
    let length = ((since >> 40) & 0xffff).max(1);
    let deposit_index = (deposit_epoch >> 24) & 0xffff;
    let deposit_length = ((deposit_epoch >> 40) & 0xffff).max(1);
    if number < target || (number == target && index * deposit_length < deposit_index * length) {
        return Err(CoreError::StateTransition);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn epoch_fraction_cannot_bypass_deadline() {
        let before = ABSOLUTE_EPOCH_FLAG | (1000 << 40) | (999 << 24) | 199;
        assert!(absolute_epoch_at_least(before, 200).is_err());
        assert!(absolute_epoch_at_least(ABSOLUTE_EPOCH_FLAG | 200, 200).is_ok());
        assert!(absolute_epoch_at_least(ABSOLUTE_EPOCH_FLAG | (1000 << 40) | 200, 200).is_ok());
    }

    #[test]
    fn reject_other_metrics_reserved_bits_and_invalid_fractions() {
        for value in [
            0,
            200,
            0xa000_0000_0000_00c8,
            0x4000_0000_0000_00c8,
            0x2100_0000_0000_00c8,
            ABSOLUTE_EPOCH_FLAG | (1 << 24) | 200,
            ABSOLUTE_EPOCH_FLAG | (1 << 40) | (1 << 24) | 200,
        ] {
            assert!(absolute_epoch_number(value).is_err(), "{value:x}");
        }
    }

    #[test]
    fn integer_encoding_bounds() {
        for number in [0, 1, 200, MAX_EPOCH_NUMBER] {
            assert_eq!(
                absolute_epoch_number(absolute_epoch_since(number).unwrap()),
                Ok(number)
            );
        }
        assert!(absolute_epoch_since(MAX_EPOCH_NUMBER + 1).is_err());
        assert!(absolute_epoch_at_least(
            ABSOLUTE_EPOCH_FLAG | MAX_EPOCH_NUMBER,
            MAX_EPOCH_NUMBER + 1
        )
        .is_err());
    }

    #[test]
    fn dao_term_preserves_the_deposit_epoch_fraction() {
        let deposit = (1000 << 40) | (500 << 24) | 10;
        let early = ABSOLUTE_EPOCH_FLAG | (1000 << 40) | (499 << 24) | 190;
        let boundary = ABSOLUTE_EPOCH_FLAG | (2 << 40) | (1 << 24) | 190;
        assert!(absolute_epoch_after_dao_term(early, deposit, 1).is_err());
        assert!(absolute_epoch_after_dao_term(boundary, deposit, 1).is_ok());
        assert!(absolute_epoch_after_dao_term(boundary, deposit, 2).is_err());
        assert!(absolute_epoch_after_dao_term(ABSOLUTE_EPOCH_FLAG | 371, deposit, 2).is_ok());
        assert!(absolute_epoch_after_dao_term(boundary, deposit, 0).is_err());
        assert!(absolute_epoch_after_dao_term(boundary, MAX_EPOCH_NUMBER, 1).is_err());
    }
}
