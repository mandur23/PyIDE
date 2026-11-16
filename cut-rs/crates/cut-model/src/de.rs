//! Reading the project's types straight from the file's text without buffering: serde's `flatten` and `untagged`
//! read every object into a temporary tree first, which costs as much as the parse itself on a long timeline. The
//! types that keep unknown fields read them through [`with_extra!`], which takes the fields it knows and keeps the rest,
//! as the derive with `flatten` did. A key given twice keeps its last value, as `JSON.parse` does.

use std::borrow::Cow;
use std::fmt;

use serde::de::{Deserialize, Deserializer, Visitor};

/// An object's key, borrowed from the text when it has no escapes.
pub(crate) struct Key<'de>(pub Cow<'de, str>);

impl<'de> Deserialize<'de> for Key<'de> {
    fn deserialize<D: Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        struct V;
        impl<'de> Visitor<'de> for V {
            type Value = Key<'de>;
            fn expecting(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
                f.write_str("a key")
            }
            fn visit_borrowed_str<E: serde::de::Error>(self, v: &'de str) -> Result<Key<'de>, E> {
                Ok(Key(Cow::Borrowed(v)))
            }
            fn visit_str<E: serde::de::Error>(self, v: &str) -> Result<Key<'de>, E> {
                Ok(Key(Cow::Owned(v.to_owned())))
            }
            fn visit_string<E: serde::de::Error>(self, v: String) -> Result<Key<'de>, E> {
                Ok(Key(Cow::Owned(v)))
            }
        }
        d.deserialize_str(V)
    }
}

/// `impl Deserialize` for a struct whose last field `extra` keeps the keys it does not name. Each field is
/// `name: "jsonName"`, required, or `name: "jsonName" default`, its type's default when missing (`None` for an
/// `Option`); `skip [a, b]` names fields the file does not hold.
macro_rules! with_extra {
    ($ty:ident, $what:literal { $($field:ident : $json:literal $($default:ident)?),* $(,)? } $(skip [$($skip:ident),*])?) => {
        impl<'de> serde::Deserialize<'de> for $ty {
            fn deserialize<D: serde::Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
                struct V;
                impl<'de> serde::de::Visitor<'de> for V {
                    type Value = $ty;
                    fn expecting(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
                        f.write_str($what)
                    }
                    fn visit_map<A: serde::de::MapAccess<'de>>(self, mut map: A) -> Result<$ty, A::Error> {
                        $(let mut $field = None;)*
                        let mut extra = $crate::project::Extra::new();
                        while let Some(key) = map.next_key::<$crate::de::Key<'de>>()? {
                            match &*key.0 {
                                $($json => $field = Some(map.next_value()?),)*
                                _ => {
                                    let v: serde_json::Value = map.next_value()?;
                                    extra.insert(key.0.into_owned(), v);
                                }
                            }
                        }
                        Ok($ty {
                            $($field: $crate::de::with_extra!(@take $field $json $($default)?),)*
                            $($($skip: Default::default(),)*)?
                            extra,
                        })
                    }
                }
                d.deserialize_map(V)
            }
        }
    };
    (@take $f:ident $json:literal) => {
        match $f {
            Some(v) => v,
            None => return Err(serde::de::Error::missing_field($json)),
        }
    };
    (@take $f:ident $json:literal default) => {
        $f.unwrap_or_default()
    };
}

pub(crate) use with_extra;
