//! Personalized PageRank over compact integer node indices.
//!
//! Mirrors `src/ask/graphrank.ts`: undirected walk over `WALK_RELATIONS` edges
//! with `alpha = 0.25`, `iters = 25`, dangling-mass redistribution, and top
//! normalization so the highest-ranked node has score 1.0.

use std::collections::HashMap;

pub const DEFAULT_ALPHA: f64 = 0.25;
pub const DEFAULT_ITERS: usize = 25;

/// Pre-built undirected adjacency over dense node indices `0..node_count`.
pub struct PageRankTopology {
    pub allowed: Vec<bool>,
    pub adjacency: Vec<Vec<usize>>,
}

impl PageRankTopology {
    pub fn build(node_count: usize, allowed: Vec<bool>, edges: &[(usize, usize)]) -> Self {
        let mut adjacency = vec![Vec::new(); node_count];
        for &(s, t) in edges {
            if s < node_count && t < node_count && allowed[s] && allowed[t] {
                adjacency[s].push(t);
                adjacency[t].push(s);
            }
        }
        Self { allowed, adjacency }
    }

    /// Build independent topologies per partition key in one edge pass.
    pub fn build_partitions(
        partition_of: &[Option<usize>],
        partition_count: usize,
        edges: &[(usize, usize)],
    ) -> Vec<Self> {
        let n = partition_of.len();
        let mut topos: Vec<Self> = (0..partition_count)
            .map(|p| Self {
                allowed: partition_of.iter().map(|&x| x == Some(p)).collect(),
                adjacency: vec![Vec::new(); n],
            })
            .collect();
        for &(s, t) in edges {
            if s < n
                && t < n
                && let Some(ps) = partition_of[s]
                && partition_of[t] == Some(ps)
            {
                topos[ps].adjacency[s].push(t);
                topos[ps].adjacency[t].push(s);
            }
        }
        topos
    }

    /// Run power iteration returning top-normalized scores for nodes with positive mass.
    pub fn run(&self, seeds: &[(usize, f64)], alpha: f64, iters: usize) -> HashMap<usize, f64> {
        let n = self.allowed.len();
        let mut seed_total = 0.0_f64;
        for &(id, w) in seeds {
            if id < n && self.allowed[id] && w > 0.0 {
                seed_total += w;
            }
        }
        if seed_total <= 0.0 {
            return HashMap::new();
        }
        let mut restart: Vec<(usize, f64)> = Vec::with_capacity(seeds.len());
        let mut rank = vec![0.0_f64; n];
        for &(id, w) in seeds {
            if id < n && self.allowed[id] && w > 0.0 {
                let r = w / seed_total;
                restart.push((id, r));
                rank[id] = r;
            }
        }
        let mut next = vec![0.0_f64; n];
        for _ in 0..iters {
            next.fill(0.0);
            for &(id, r) in &restart {
                next[id] = alpha * r;
            }
            let mut dangling = 0.0_f64;
            for (id, &mass) in rank.iter().enumerate() {
                if mass == 0.0 {
                    continue;
                }
                let nbrs = &self.adjacency[id];
                if nbrs.is_empty() {
                    dangling += mass;
                    continue;
                }
                let share = ((1.0 - alpha) * mass) / (nbrs.len() as f64);
                for &nb in nbrs {
                    next[nb] += share;
                }
            }
            if dangling > 0.0 {
                let dm = (1.0 - alpha) * dangling;
                for &(sid, r) in &restart {
                    next[sid] += dm * r;
                }
            }
            std::mem::swap(&mut rank, &mut next);
        }

        let mut max_val = 0.0_f64;
        for &v in &rank {
            if v > max_val {
                max_val = v;
            }
        }
        if max_val <= 0.0 {
            return HashMap::new();
        }
        let mut out = HashMap::new();
        for (id, &v) in rank.iter().enumerate() {
            if v > 0.0 {
                out.insert(id, v / max_val);
            }
        }
        out
    }
}
