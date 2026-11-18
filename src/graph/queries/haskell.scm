; Haskell: top-level and local functions and value bindings, data types,
; newtypes, type synonyms and classes. Only an unqualified call (`helper x`)
; names its function; `Map.lookup k m` keeps its module and stays unresolved
; rather than guessed.
(function
  name: (variable) @name) @definition.function

(bind
  name: (variable) @name) @definition.function

(data_type
  name: (name) @name) @definition.type

(newtype
  name: (name) @name) @definition.type

(type_synomym
  name: (name) @name) @definition.type

(class
  name: (name) @name) @definition.type

(apply
  function: (variable) @name) @reference.call
