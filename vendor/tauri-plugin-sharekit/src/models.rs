use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum RectEdge {
    Top,
    Bottom,
    Left,
    Right,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SharePosition {
    pub x: f64,
    pub y: f64,
    /// macOS only: which edge the picker appears from
    #[serde(skip_serializing_if = "Option::is_none")]
    pub preferred_edge: Option<RectEdge>,
}

#[derive(Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ShareTextOptions {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub mime_type: Option<String>,
    /// Position for the share sheet (iPad/macOS only)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub position: Option<SharePosition>,
}

#[derive(Serialize)]
pub struct ShareTextPayload {
    pub text: String,
    #[serde(flatten)]
    pub options: ShareTextOptions,
}

#[derive(Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ShareFileOptions {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub mime_type: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    /// Position for the share sheet (iPad/macOS only)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub position: Option<SharePosition>,
}

#[derive(Serialize)]
pub struct ShareFilePayload {
    pub url: String,
    #[serde(flatten)]
    pub options: ShareFileOptions,
}
