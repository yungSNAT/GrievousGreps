//! Deployment files, from `src/graph/deploy.ts`. Stage 3B1 ports only `deployFormatOf`.

/// `KUSTOMIZATION_FILES`: the names Kustomize reads a kustomization from.
const KUSTOMIZATION_FILES: &[&str] = &["kustomization.yaml", "kustomization.yml", "Kustomization"];

/// `posix.basename` of `path` with backslashes read as slashes: trailing slashes are
/// dropped, then the last component is kept.
fn basename(path: &str) -> String {
    let p = path.replace('\\', "/");
    let trimmed = p.trim_end_matches('/');
    trimmed.rsplit('/').next().unwrap_or("").to_owned()
}

/// A JavaScript regular-expression `.+`: at least one character, none a line terminator.
fn dot_plus(s: &str) -> bool {
    !s.is_empty() && !s.contains(['\n', '\r', '\u{2028}', '\u{2029}'])
}

/// `/^(dockerfile([._-].+)?|.+\.dockerfile|containerfile)$/` on a lower-cased name.
fn is_dockerfile(base: &str) -> bool {
    if base == "dockerfile" || base == "containerfile" {
        return true;
    }
    if let Some(rest) = base.strip_prefix("dockerfile")
        && let Some(tail) = rest.strip_prefix(['.', '_', '-'])
        && dot_plus(tail)
    {
        return true;
    }
    base.strip_suffix(".dockerfile").is_some_and(dot_plus)
}

/// `/^(docker-)?compose(\.[^/]+)?\.ya?ml$/` on a lower-cased name.
fn is_compose(base: &str) -> bool {
    let after = |s: &str| {
        let Some(rest) = s.strip_prefix("compose") else {
            return false;
        };
        let Some(middle) = rest
            .strip_suffix(".yml")
            .or_else(|| rest.strip_suffix(".yaml"))
        else {
            return false;
        };
        middle.is_empty() || (middle.len() > 1 && middle.starts_with('.') && !middle.contains('/'))
    };
    base.strip_prefix("docker-").is_some_and(after) || after(base)
}

/// `deployFormatOf`: the deployment format a path's name says, or `None`. Every other
/// YAML file is a Kubernetes manifest candidate.
#[must_use]
pub fn deploy_format_of(path: &str) -> Option<&'static str> {
    let exact = basename(path);
    if KUSTOMIZATION_FILES.contains(&exact.as_str()) {
        return Some("kustomize");
    }
    let base = exact.to_lowercase();
    if base.ends_with(".dockerignore") {
        return None;
    }
    if is_dockerfile(&base) {
        return Some("dockerfile");
    }
    if is_compose(&base) {
        return Some("compose");
    }
    // Terraform reads `.tf` exactly; `.tf.json` files are not read.
    if exact.ends_with(".tf") {
        return Some("terraform");
    }
    (base.ends_with(".yml") || base.ends_with(".yaml")).then_some("kubernetes")
}

#[cfg(test)]
mod tests {
    use super::deploy_format_of as f;

    #[test]
    fn names_as_typescript_reads_them() {
        assert_eq!(f("a\\b\\Dockerfile"), Some("dockerfile"));
        assert_eq!(f("Dockerfile/"), Some("dockerfile"));
        assert_eq!(f("dockerfile."), None);
        assert_eq!(f("dockerfile.\n"), None);
        assert_eq!(f(".dockerfile"), None);
        assert_eq!(f("api.Dockerfile"), Some("dockerfile"));
        assert_eq!(f("app.dockerignore"), None);
        assert_eq!(f("docker-compose.yml"), Some("compose"));
        assert_eq!(f("compose.prod.yaml"), Some("compose"));
        assert_eq!(f("compose..yml"), Some("kubernetes"));
        assert_eq!(f("docker-docker-compose.yml"), Some("kubernetes"));
        assert_eq!(f("Dockerfile_"), None);
        assert_eq!(f("DOCKERFILE-x"), Some("dockerfile"));
        assert_eq!(f("compose.\n.yml"), Some("compose"));
        assert_eq!(f("compose.yml.bak"), None);
        assert_eq!(f("composer.yml"), Some("kubernetes"));
        assert_eq!(f("KUSTOMIZATION.yaml"), Some("kubernetes"));
        assert_eq!(f("Kustomization"), Some("kustomize"));
        assert_eq!(f("main.TF"), None);
        assert_eq!(f("x.tf.json"), None);
        // JavaScript's `$` without the `m` flag matches only at the end of input, never
        // before a final line terminator (checked against deployFormatOf on Node 26).
        assert_eq!(f("Dockerfile\n"), None);
        assert_eq!(f("Dockerfile\r"), None);
        assert_eq!(f("Dockerfile\u{2029}"), None);
        assert_eq!(f("compose.yml\n"), None);
        assert_eq!(f("compose.yml\u{2028}"), None);
        assert_eq!(f("x.yaml\n"), None);
        assert_eq!(f("/"), None);
        assert_eq!(f(""), None);
    }
}
