; Objective-C: classes and protocols, methods (named by the first part of
; their selector) and C functions. A message names its method by the selector
; part just after the receiver, unless the receiver is `super`, whose method is
; the parent class's; a C call names its function. Method declarations in an
; @interface are left out, so a call has one target.
(class_implementation
  .
  (identifier) @name) @definition.class

(protocol_declaration
  .
  (identifier) @name) @definition.interface

(method_definition
  (method_type)
  .
  (identifier) @name) @definition.method

(method_definition
  .
  (identifier) @name) @definition.method

(function_definition
  declarator: (function_declarator
    declarator: (identifier) @name)) @definition.function

(message_expression
  receiver: (_) @receiver
  .
  method: (identifier) @name
  (#not-eq? @receiver "super")) @reference.call

(call_expression
  function: (identifier) @name) @reference.call
