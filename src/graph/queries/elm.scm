; Elm: top-level values with or without arguments, custom types and type
; aliases. Only an unqualified call (`helper x`) names its function;
; `List.map f xs` keeps its module and stays unresolved rather than guessed.
(value_declaration
  (function_declaration_left
    .
    (lower_case_identifier) @name)) @definition.function

(type_declaration
  name: (upper_case_identifier) @name) @definition.type

(type_alias_declaration
  name: (upper_case_identifier) @name) @definition.type

(function_call_expr
  target: (value_expr
    name: (value_qid
      .
      (lower_case_identifier) @name
      .))) @reference.call
