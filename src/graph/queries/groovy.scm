; Groovy: classes and `def`/typed functions and methods. A call names its
; function, or its last name after dots (`obj.go()`), and a command call
; without parentheses (`println "hi"`) names its function too.
(class_definition
  name: (identifier) @name) @definition.class

(function_definition
  function: (identifier) @name) @definition.function

(function_call
  function: (identifier) @name) @reference.call

(function_call
  function: (dotted_identifier
    (identifier) @name
    .)) @reference.call

(juxt_function_call
  function: (identifier) @name) @reference.call
