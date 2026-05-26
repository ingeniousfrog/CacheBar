use image::{imageops::FilterType, Rgba, RgbaImage};
use tauri::image::Image;

/// Menu-bar tray size (@2x). macOS scales down to ~22pt.
const TRAY_PX: u32 = 44;
const CORNER_RADIUS: f32 = 10.0;

pub fn load_tray_icon() -> Result<Image<'static>, String> {
    let decoded = image::load_from_memory(include_bytes!("../icons/icon.png"))
        .map_err(|err| format!("tray icon decode failed: {err}"))?;
    let resized = decoded
        .resize_exact(TRAY_PX, TRAY_PX, FilterType::Lanczos3)
        .to_rgba8();
    let masked = mask_rounded_corners(resized, CORNER_RADIUS);
    Ok(Image::new_owned(masked.into_raw(), TRAY_PX, TRAY_PX))
}

fn mask_rounded_corners(img: RgbaImage, radius: f32) -> RgbaImage {
    let (width, height) = img.dimensions();
    let mut out = img;
    for y in 0..height {
        for x in 0..width {
            if !inside_rounded_rect(x as f32 + 0.5, y as f32 + 0.5, width as f32, height as f32, radius)
            {
                out.put_pixel(x, y, Rgba([0, 0, 0, 0]));
            }
        }
    }
    out
}

fn inside_rounded_rect(x: f32, y: f32, width: f32, height: f32, radius: f32) -> bool {
    if x < radius && y < radius {
        let dx = x - radius;
        let dy = y - radius;
        return dx * dx + dy * dy <= radius * radius;
    }
    if x > width - radius && y < radius {
        let dx = x - (width - radius);
        let dy = y - radius;
        return dx * dx + dy * dy <= radius * radius;
    }
    if x < radius && y > height - radius {
        let dx = x - radius;
        let dy = y - (height - radius);
        return dx * dx + dy * dy <= radius * radius;
    }
    if x > width - radius && y > height - radius {
        let dx = x - (width - radius);
        let dy = y - (height - radius);
        return dx * dx + dy * dy <= radius * radius;
    }
    true
}
