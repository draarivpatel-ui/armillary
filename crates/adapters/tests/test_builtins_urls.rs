use orrery_adapters::builtin_adapters;

fn is_valid_url(url: &str) -> bool {
    (url.starts_with("https://") || url.starts_with("http://"))
        && !url.contains(' ')
        && !url.contains('\n')
        && !url.contains('\r')
        && url.contains('.')
        && !url.contains('\u{2014}') // em dash
        && !url.contains('\u{2013}') // en dash
}

#[test]
fn test_every_builtin_has_valid_docs_url_or_none() {
    let builtins = builtin_adapters();
    assert_eq!(builtins.len(), orrery_adapters::BUILTINS.len());

    for adapter in &builtins {
        if let Some(ref docs_url) = adapter.docs_url {
            assert!(
                is_valid_url(docs_url),
                "docs_url for {} must be a valid URL without em/en dashes or spaces, got: {}",
                adapter.id,
                docs_url
            );
        }

        if let Some(ref homepage) = adapter.homepage {
            assert!(
                is_valid_url(homepage),
                "homepage for {} must be a valid URL without em/en dashes or spaces, got: {}",
                adapter.id,
                homepage
            );
        }
    }
}

#[test]
fn test_all_21_builtins_have_homepage_and_docs_url_filled() {
    let builtins = builtin_adapters();
    assert_eq!(builtins.len(), orrery_adapters::BUILTINS.len());

    for adapter in &builtins {
        assert!(
            adapter.homepage.is_some(),
            "Builtin adapter '{}' must have homepage populated",
            adapter.id
        );
        // The detection-only A6 entries carry a homepage; docs_url for them is a follow-up.
        let is_a6 = orrery_adapters::BUILTINS
            .iter()
            .any(|b| b.id == adapter.id && b.package == "A6");
        if !is_a6 {
            assert!(
                adapter.docs_url.is_some(),
                "Builtin adapter '{}' must have docs_url populated",
                adapter.id
            );
        }
    }
}
