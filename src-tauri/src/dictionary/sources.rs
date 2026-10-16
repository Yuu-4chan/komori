use serde::{Deserialize, Serialize};

/// Stable source choices; an unavailable explicit selection never becomes All.
#[derive(Debug, Clone, Default, PartialEq, Serialize)]
#[serde(tag = "mode", rename_all = "lowercase", deny_unknown_fields)]
pub enum SourceSelection {
    #[default]
    All,
    None,
    Selected {
        ids: Vec<i64>,
    },
}

impl<'de> Deserialize<'de> for SourceSelection {
    fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let value = serde_json::Value::deserialize(deserializer)?;
        let invalid = || serde::de::Error::custom("Invalid dictionary source selection");
        let object = value.as_object().ok_or_else(invalid)?;
        let selection = match object.get("mode").and_then(serde_json::Value::as_str) {
            Some("all") if object.len() == 1 => Self::All,
            Some("none") if object.len() == 1 => Self::None,
            Some("selected") if object.len() == 2 => Self::Selected {
                ids: serde_json::from_value(object.get("ids").ok_or_else(invalid)?.clone())
                    .map_err(|_| invalid())?,
            },
            _ => return Err(invalid()),
        };
        if !selection.is_valid() {
            return Err(invalid());
        }
        Ok(selection)
    }
}

impl SourceSelection {
    pub fn is_valid(&self) -> bool {
        match self {
            Self::Selected { ids } => {
                ids.len() <= 128
                    && ids
                        .iter()
                        .all(|id| (1..=9_007_199_254_740_991).contains(id))
                    && ids
                        .iter()
                        .enumerate()
                        .all(|(index, id)| !ids[..index].contains(id))
            }
            _ => true,
        }
    }

    /// Points selected IDs at other dictionaries, dropping those `map` cannot name; All and None
    /// stay, and a selection left without IDs selects nothing.
    pub fn remap(&mut self, map: impl Fn(i64) -> Option<i64>) {
        if let Self::Selected { ids } = self {
            *ids = ids.iter().filter_map(|id| map(*id)).collect();
        }
    }

    pub(super) fn sql_ids(&self) -> Option<String> {
        match self {
            Self::All => None,
            Self::None => Some("[]".into()),
            Self::Selected { ids } => Some(serde_json::to_string(ids).expect("integer IDs")),
        }
    }
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SourcePolicy {
    pub definitions: SourceSelection,
    pub frequency: SourceSelection,
    pub pitch: SourceSelection,
}

impl SourcePolicy {
    pub fn is_valid(&self) -> bool {
        [&self.definitions, &self.frequency, &self.pitch]
            .iter()
            .all(|role| role.is_valid())
    }
}
