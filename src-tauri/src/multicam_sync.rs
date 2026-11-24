pub const HZ: usize = 100;
pub const FRAME: usize = 80;
const COARSE: usize = 5;

pub fn envelope(energies: &[f64]) -> Vec<f64> {
    let mut floor = 0.0;
    energies.iter().map(|&energy| {
        let level = (1.0 + 100.0 * energy.sqrt()).ln();
        let onset = (level - floor).max(0.0);
        floor += 0.22 * (level - floor);
        onset
    }).collect()
}

// Positive lag places the candidate later on the reference clock.
pub fn correlate(reference: &[f64], candidate: &[f64], max_lag: usize) -> (f64, f64) {
    let min_overlap = (reference.len().min(candidate.len()) / 3).clamp(HZ / 2, HZ * 3);
    let pool = |frames: &[f64]| -> Vec<f64> {
        frames.chunks(COARSE).map(|bin| bin.iter().copied().fold(0.0, f64::max)).collect()
    };
    let (coarse_ref, coarse_candidate) = (pool(reference), pool(candidate));
    let score = |a: &[f64], b: &[f64], lag: isize, minimum: usize| {
        let (i, j) = (lag.max(0) as usize, (-lag).max(0) as usize);
        let n = a.len().saturating_sub(i).min(b.len().saturating_sub(j));
        if n < minimum { return 0.0; }
        let (mut x, mut y, mut xx, mut yy, mut xy) = (0.0, 0.0, 0.0, 0.0, 0.0);
        for (&u, &v) in a[i..i + n].iter().zip(&b[j..j + n]) {
            x += u; y += v; xx += u * u; yy += v * v; xy += u * v;
        }
        let n = n as f64;
        let variance = (xx - x * x / n) * (yy - y * y / n);
        if variance <= 1e-12 { 0.0 } else { (xy - x * y / n) / variance.sqrt() }
    };
    let limit = max_lag as isize;
    let bins = max_lag.div_ceil(COARSE) as isize;
    let mut candidates: Vec<_> = (-bins..=bins).map(|lag| {
        (score(&coarse_ref, &coarse_candidate, lag, min_overlap.div_ceil(COARSE)), lag)
    }).collect();
    candidates.sort_unstable_by(|a, b| b.0.total_cmp(&a.0));
    let mut peaks = Vec::new();
    for (_, lag) in candidates {
        let center = lag * COARSE as isize;
        if peaks.iter().any(|p: &isize| (*p - center).abs() <= COARSE as isize) { continue; }
        peaks.push(center);
        if peaks.len() == 12 { break; }
    }
    let mut fine = vec![(0.0, 0)];
    for center in peaks {
        for lag in (center - COARSE as isize).max(-limit)..=(center + COARSE as isize).min(limit) {
            fine.push((score(reference, candidate, lag, min_overlap), lag));
        }
    }
    let &(best, lag) = fine.iter().max_by(|a, b| a.0.total_cmp(&b.0)).unwrap();
    let rival = fine.iter().filter(|(_, other)| (lag - other).abs() > COARSE as isize)
        .map(|(score, _)| *score).fold(0.0, f64::max);
    if best <= 0.0 { return (0.0, 0.0); }
    let confidence = best.clamp(0.0, 1.0) * ((best - rival) / 0.25).clamp(0.0, 1.0);
    (lag as f64 / HZ as f64, confidence)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn aligns_positive_and_negative_offsets() {
        let mut energy = vec![0.0; 2400];
        for (i, width) in [(20, 13), (83, 5), (157, 73), (292, 33), (510, 19), (611, 37), (953, 23)] {
            energy[i..i + width].fill(0.05 + width as f64 / 100.0);
        }
        let a = envelope(&energy[..1400]);
        let b = envelope(&energy[137..1600]);
        let (offset, confidence) = correlate(&a, &b, 6000);
        assert_eq!(offset, 1.37);
        assert!(confidence > 0.65, "{confidence}");
        let (offset, confidence) = correlate(&b, &a, 6000);
        assert_eq!(offset, -1.37);
        assert!(confidence > 0.65, "{confidence}");
    }

    #[test]
    fn flags_silence_and_periodic_matches() {
        assert_eq!(correlate(&[0.0; 300], &[0.0; 300], 100), (0.0, 0.0));
        let repetitive: Vec<_> = (0..600).map(|i| if i % 20 == 0 { 1.0 } else { 0.0 }).collect();
        assert!(correlate(&repetitive, &repetitive, 100).1 < 0.1);
    }
}
