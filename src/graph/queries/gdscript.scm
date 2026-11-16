; GDScript: `func`, inner `class` and the script's own `class_name`. A bare call
; and a method call on any receiver but `super` name their function; `super`'s
; method is the parent class's, never the one being defined.
(function_definition
  name: (name) @name) @definition.function

(class_definition
  name: (name) @name) @definition.class

(class_name_statement
  name: (name) @name) @definition.class

(call
  .
  (identifier) @name) @reference.call

(attribute
  (_) @receiver
  .
  (attribute_call
    .
    (identifier) @name)
  (#not-eq? @receiver "super")) @reference.call
