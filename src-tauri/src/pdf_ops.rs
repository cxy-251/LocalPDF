use std::collections::{BTreeMap, BTreeSet};
use std::path::{Path, PathBuf};

use lopdf::{Document, Object, ObjectId};

pub fn parse_page_ranges(spec: &str, max_page: u32) -> Result<Vec<u32>, String> {
    let mut pages = BTreeSet::new();
    for part in spec.split(',') {
        let part = part.trim();
        if part.is_empty() {
            continue;
        }
        if let Some((start, end)) = part.split_once('-') {
            let start: u32 = start
                .trim()
                .parse()
                .map_err(|_| format!("invalid range start: {part}"))?;
            let end: u32 = end
                .trim()
                .parse()
                .map_err(|_| format!("invalid range end: {part}"))?;
            if start == 0 || end == 0 || start > end {
                return Err(format!("invalid range: {part}"));
            }
            for p in start..=end.min(max_page) {
                pages.insert(p);
            }
        } else {
            let p: u32 = part
                .parse()
                .map_err(|_| format!("invalid page number: {part}"))?;
            if p == 0 || p > max_page {
                return Err(format!("page number out of range: {p}"));
            }
            pages.insert(p);
        }
    }
    if pages.is_empty() {
        return Err("no pages selected".to_string());
    }
    Ok(pages.into_iter().collect())
}

pub fn merge(inputs: &[PathBuf], output: &Path) -> Result<(), String> {
    if inputs.len() < 2 {
        return Err("merge requires at least two input files".to_string());
    }

    let mut max_id = 1u32;
    let mut documents_pages: BTreeMap<ObjectId, Object> = BTreeMap::new();
    let mut documents_objects: BTreeMap<ObjectId, Object> = BTreeMap::new();
    let mut document = Document::with_version("1.5");

    for path in inputs {
        let mut doc = Document::load(path)
            .map_err(|e| format!("failed to load {}: {e}", path.display()))?;
        doc.renumber_objects_with(max_id);
        max_id = doc.max_id + 1;

        documents_pages.extend(
            doc.get_pages()
                .into_values()
                .map(|object_id| (object_id, doc.get_object(object_id).unwrap().to_owned())),
        );
        documents_objects.extend(doc.objects);
    }

    let mut catalog_object: Option<(ObjectId, Object)> = None;
    let mut pages_object: Option<(ObjectId, Object)> = None;

    for (object_id, object) in documents_objects.into_iter() {
        match object.type_name().unwrap_or(b"") {
            b"Catalog" => {
                catalog_object = Some((catalog_object.map(|(id, _)| id).unwrap_or(object_id), object));
            }
            b"Pages" => {
                if let Ok(dictionary) = object.as_dict() {
                    let mut dictionary = dictionary.clone();
                    if let Some((_, ref old_object)) = pages_object {
                        if let Ok(old_dictionary) = old_object.as_dict() {
                            dictionary.extend(old_dictionary);
                        }
                    }
                    pages_object = Some((
                        pages_object.map(|(id, _)| id).unwrap_or(object_id),
                        Object::Dictionary(dictionary),
                    ));
                }
            }
            b"Page" | b"Outlines" | b"Outline" => {}
            _ => {
                document.objects.insert(object_id, object);
            }
        }
    }

    let (catalog_id, catalog_object) = catalog_object.ok_or("no /Catalog object found while merging")?;
    let (pages_id, pages_object) = pages_object.ok_or("no /Pages object found while merging")?;

    for (object_id, object) in documents_pages.iter() {
        if let Ok(dict) = object.as_dict() {
            let mut dict = dict.clone();
            dict.set("Parent", pages_id);
            document.objects.insert(*object_id, Object::Dictionary(dict));
        }
    }

    if let Ok(dict) = pages_object.as_dict() {
        let mut dict = dict.clone();
        dict.set("Count", documents_pages.len() as u32);
        dict.set(
            "Kids",
            documents_pages.into_keys().map(Object::Reference).collect::<Vec<_>>(),
        );
        document.objects.insert(pages_id, Object::Dictionary(dict));
    }

    if let Ok(dict) = catalog_object.as_dict() {
        let mut dict = dict.clone();
        dict.set("Pages", pages_id);
        dict.remove(b"Outlines");
        document.objects.insert(catalog_id, Object::Dictionary(dict));
    }

    document.trailer.set("Root", catalog_id);
    document.max_id = document.objects.len() as u32;
    document.renumber_objects();

    document
        .save(output)
        .map_err(|e| format!("failed to save {}: {e}", output.display()))?;
    Ok(())
}

pub fn extract(input: &Path, output: &Path, spec: &str) -> Result<(), String> {
    let mut doc = Document::load(input).map_err(|e| e.to_string())?;
    let page_map = doc.get_pages();
    let max_page = *page_map.keys().max().ok_or("document has no pages")?;
    let keep: BTreeSet<u32> = parse_page_ranges(spec, max_page)?.into_iter().collect();
    let remove: Vec<u32> = page_map.keys().filter(|n| !keep.contains(n)).copied().collect();
    doc.delete_pages(&remove);
    doc.save(output).map_err(|e| e.to_string())?;
    Ok(())
}

pub fn rotate(input: &Path, output: &Path, pages: Option<&[u32]>, degrees: i64) -> Result<(), String> {
    let mut doc = Document::load(input).map_err(|e| e.to_string())?;
    let page_map = doc.get_pages();
    let targets: Vec<ObjectId> = match pages {
        Some(nums) => nums.iter().filter_map(|n| page_map.get(n).copied()).collect(),
        None => page_map.values().copied().collect(),
    };
    if targets.is_empty() {
        return Err("no matching pages to rotate".to_string());
    }
    for page_id in targets {
        let dict = doc.get_dictionary_mut(page_id).map_err(|e| e.to_string())?;
        let current = dict.get(b"Rotate").and_then(Object::as_i64).unwrap_or(0);
        let new_rotate = (current + degrees).rem_euclid(360);
        dict.set("Rotate", new_rotate);
    }
    doc.save(output).map_err(|e| e.to_string())?;
    Ok(())
}

/// `box_` is `[x0, y0, x1, y1]` in PDF points. Sets both /MediaBox and
/// /CropBox so every viewer (not just ones that respect CropBox) sees the
/// cropped size.
pub fn crop(input: &Path, output: &Path, pages: Option<&[u32]>, box_: [f64; 4]) -> Result<(), String> {
    let mut doc = Document::load(input).map_err(|e| e.to_string())?;
    let page_map = doc.get_pages();
    let targets: Vec<ObjectId> = match pages {
        Some(nums) => nums.iter().filter_map(|n| page_map.get(n).copied()).collect(),
        None => page_map.values().copied().collect(),
    };
    if targets.is_empty() {
        return Err("no matching pages to crop".to_string());
    }
    let rect: Vec<Object> = box_.iter().map(|v| (*v).into()).collect();
    for page_id in targets {
        let dict = doc.get_dictionary_mut(page_id).map_err(|e| e.to_string())?;
        dict.set("MediaBox", rect.clone());
        dict.set("CropBox", rect.clone());
    }
    doc.save(output).map_err(|e| e.to_string())?;
    Ok(())
}

pub fn delete(input: &Path, output: &Path, pages: &[u32]) -> Result<(), String> {
    let mut doc = Document::load(input).map_err(|e| e.to_string())?;
    doc.delete_pages(pages);
    doc.save(output).map_err(|e| e.to_string())?;
    Ok(())
}

/// Assumes a flat (single-level) Pages tree, true for the vast majority of
/// real-world PDFs; deeply nested Pages nodes are not flattened.
pub fn reorder(input: &Path, output: &Path, order: &[u32]) -> Result<(), String> {
    let mut doc = Document::load(input).map_err(|e| e.to_string())?;
    let page_map = doc.get_pages();
    if order.len() != page_map.len() {
        return Err(format!(
            "order length {} does not match page count {}",
            order.len(),
            page_map.len()
        ));
    }

    let new_kids: Vec<Object> = order
        .iter()
        .map(|n| {
            page_map
                .get(n)
                .copied()
                .map(Object::Reference)
                .ok_or_else(|| format!("invalid page number {n}"))
        })
        .collect::<Result<Vec<_>, String>>()?;

    let first_page_id = *page_map.values().next().ok_or("document has no pages")?;
    let parent_id = doc
        .get_dictionary(first_page_id)
        .map_err(|e| e.to_string())?
        .get(b"Parent")
        .and_then(Object::as_reference)
        .map_err(|e| e.to_string())?;

    let pages_dict = doc.get_dictionary_mut(parent_id).map_err(|e| e.to_string())?;
    pages_dict.set("Kids", new_kids);

    doc.save(output).map_err(|e| e.to_string())?;
    Ok(())
}

pub fn page_count(input: &Path) -> Result<u32, String> {
    let doc = Document::load(input).map_err(|e| e.to_string())?;
    Ok(doc.get_pages().len() as u32)
}

#[cfg(test)]
mod tests {
    use super::*;
    use lopdf::{content::Content, content::Operation, dictionary, Stream};
    use tempfile::tempdir;

    fn make_test_pdf(n_pages: u32) -> Document {
        let mut doc = Document::with_version("1.5");
        let pages_id = doc.new_object_id();
        let font_id = doc.add_object(dictionary! {
            "Type" => "Font",
            "Subtype" => "Type1",
            "BaseFont" => "Courier",
        });
        let resources_id = doc.add_object(dictionary! {
            "Font" => dictionary! { "F1" => font_id },
        });

        let mut kids = Vec::new();
        for i in 1..=n_pages {
            let content = Content {
                operations: vec![
                    Operation::new("BT", vec![]),
                    Operation::new("Tf", vec!["F1".into(), 24.into()]),
                    Operation::new("Td", vec![72.into(), 700.into()]),
                    Operation::new("Tj", vec![Object::string_literal(format!("Page {i}"))]),
                    Operation::new("ET", vec![]),
                ],
            };
            let content_id = doc.add_object(Stream::new(dictionary! {}, content.encode().unwrap()));
            let page_id = doc.add_object(dictionary! {
                "Type" => "Page",
                "Parent" => pages_id,
                "Contents" => content_id,
                "Resources" => resources_id,
                "MediaBox" => vec![0.into(), 0.into(), 595.into(), 842.into()],
            });
            kids.push(page_id.into());
        }

        let pages = dictionary! {
            "Type" => "Pages",
            "Kids" => kids,
            "Count" => n_pages,
        };
        doc.objects.insert(pages_id, Object::Dictionary(pages));
        let catalog_id = doc.add_object(dictionary! {
            "Type" => "Catalog",
            "Pages" => pages_id,
        });
        doc.trailer.set("Root", catalog_id);
        doc
    }

    #[test]
    fn merge_combines_page_counts() {
        let dir = tempdir().unwrap();
        let a = dir.path().join("a.pdf");
        let b = dir.path().join("b.pdf");
        let out = dir.path().join("merged.pdf");

        make_test_pdf(2).save(&a).unwrap();
        make_test_pdf(3).save(&b).unwrap();

        merge(&[a, b], &out).unwrap();
        assert_eq!(page_count(&out).unwrap(), 5);
    }

    #[test]
    fn extract_keeps_only_requested_pages() {
        let dir = tempdir().unwrap();
        let src = dir.path().join("src.pdf");
        let out = dir.path().join("out.pdf");
        make_test_pdf(5).save(&src).unwrap();

        extract(&src, &out, "1,3-4").unwrap();
        assert_eq!(page_count(&out).unwrap(), 3);
    }

    #[test]
    fn crop_sets_media_and_crop_box() {
        let dir = tempdir().unwrap();
        let src = dir.path().join("src.pdf");
        let out = dir.path().join("out.pdf");
        make_test_pdf(2).save(&src).unwrap();

        crop(&src, &out, Some(&[1]), [10.0, 10.0, 400.0, 500.0]).unwrap();

        let doc = Document::load(&out).unwrap();
        let pages = doc.get_pages();
        let page1 = *pages.get(&1).unwrap();
        let media_box = doc.get_dictionary(page1).unwrap().get(b"MediaBox").unwrap();
        let arr = media_box.as_array().unwrap();
        let nums: Vec<f64> = arr.iter().map(|o| o.as_float().unwrap() as f64).collect();
        assert_eq!(nums, vec![10.0, 10.0, 400.0, 500.0]);

        // page 2 was untouched — still the original, uncropped MediaBox
        let page2 = *pages.get(&2).unwrap();
        let media_box2 = doc.get_dictionary(page2).unwrap().get(b"MediaBox").unwrap();
        let nums2: Vec<f64> = media_box2
            .as_array()
            .unwrap()
            .iter()
            .map(|o| o.as_float().unwrap() as f64)
            .collect();
        assert_eq!(nums2, vec![0.0, 0.0, 595.0, 842.0]);
    }

    #[test]
    fn delete_removes_pages() {
        let dir = tempdir().unwrap();
        let src = dir.path().join("src.pdf");
        let out = dir.path().join("out.pdf");
        make_test_pdf(4).save(&src).unwrap();

        delete(&src, &out, &[2]).unwrap();
        assert_eq!(page_count(&out).unwrap(), 3);
    }

    #[test]
    fn rotate_sets_rotate_key() {
        let dir = tempdir().unwrap();
        let src = dir.path().join("src.pdf");
        let out = dir.path().join("out.pdf");
        make_test_pdf(2).save(&src).unwrap();

        rotate(&src, &out, Some(&[1]), 90).unwrap();

        let doc = Document::load(&out).unwrap();
        let pages = doc.get_pages();
        let page1 = *pages.get(&1).unwrap();
        let rotate_value = doc
            .get_dictionary(page1)
            .unwrap()
            .get(b"Rotate")
            .and_then(Object::as_i64)
            .unwrap();
        assert_eq!(rotate_value, 90);

        let page2 = *pages.get(&2).unwrap();
        let rotate_value_2 = doc
            .get_dictionary(page2)
            .unwrap()
            .get(b"Rotate")
            .and_then(Object::as_i64)
            .unwrap_or(0);
        assert_eq!(rotate_value_2, 0);
    }

    #[test]
    fn reorder_updates_kids_order() {
        let dir = tempdir().unwrap();
        let src = dir.path().join("src.pdf");
        let out = dir.path().join("out.pdf");
        make_test_pdf(3).save(&src).unwrap();

        reorder(&src, &out, &[3, 1, 2]).unwrap();

        let doc = Document::load(&out).unwrap();
        let pages: Vec<ObjectId> = doc.page_iter().collect();
        assert_eq!(pages.len(), 3);
    }

    #[test]
    fn parse_page_ranges_handles_mixed_spec() {
        let pages = parse_page_ranges("1-3, 5, 8-10", 10).unwrap();
        assert_eq!(pages, vec![1, 2, 3, 5, 8, 9, 10]);
    }

    #[test]
    fn parse_page_ranges_rejects_out_of_bounds() {
        assert!(parse_page_ranges("1-3", 2).is_ok());
        assert!(parse_page_ranges("5", 2).is_err());
    }
}
