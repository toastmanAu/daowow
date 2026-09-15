mod common;
// host-side reproduction of the settlement proof check
use daowow_core::accumulator::smt::host::SmtHost;
use daowow_core::leaf::liability_leaf;

#[test]
fn repro_settlement_proof() {
    let mut world = ckb_testtool::context::Context::new_with_deterministic_rng();
    let _ = &mut world;
    let round_id = [0x44u8; 32];
    let mut host = SmtHost::new();
    let mut parts = Vec::new();
    for i in 0..6u64 {
        let lock = {
            // derive distinct pseudo locks without a context
            let mut h = [0u8; 32];
            h[0..8].copy_from_slice(&i.to_be_bytes());
            h
        };
        let p = 100u64;
        let z = 10u64;
        parts.push((lock, p, z));
    }
    for (lh, p, z) in &parts {
        host.insert(lh, &liability_leaf(lh, *p, *z)).unwrap();
    }
    let root = host.root();
    for (lh, p, z) in &parts {
        let proof = host.inclusion_proof(&[*lh]).unwrap();
        assert!(
            daowow_core::accumulator::smt::verify_membership(
                &root,
                lh,
                &liability_leaf(lh, *p, *z),
                &proof
            )
            .is_ok(),
            "proof should verify for {:?}",
            lh
        );
    }
}
