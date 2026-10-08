import UIKit
@main class AppDelegate: UIResponder, UIApplicationDelegate {
 var window:UIWindow?
 func application(_ application:UIApplication,didFinishLaunchingWithOptions options:[UIApplication.LaunchOptionsKey:Any]?)->Bool {
  let w=UIWindow(frame:UIScreen.main.bounds);w.rootViewController=ProofController();w.makeKeyAndVisible();window=w;return true
 }
}
class ProofController:UIViewController {
 let state=UILabel();let start=UIButton(type:.system);let dismiss=UIButton(type:.system)
 override func viewDidLoad(){
  super.viewDidLoad();view.backgroundColor = .systemBackground
  state.text="Ready";state.accessibilityIdentifier="ready";state.textAlignment = .center;state.frame=CGRect(x:30,y:200,width:330,height:70);view.addSubview(state)
  start.setTitle("Start delayed notice",for:.normal);start.frame=CGRect(x:30,y:300,width:330,height:60);start.addTarget(self,action:#selector(begin),for:.touchUpInside);view.addSubview(start)
  dismiss.setTitle("Dismiss notice",for:.normal);dismiss.frame=CGRect(x:30,y:400,width:330,height:60);dismiss.addTarget(self,action:#selector(handle),for:.touchUpInside);dismiss.isHidden=true;view.addSubview(dismiss)
 }
 @objc func begin(){state.text="Waiting";state.accessibilityIdentifier="waiting";start.isHidden=true;DispatchQueue.main.asyncAfter(deadline:.now()+3){self.state.text="Notice ready";self.state.accessibilityIdentifier="notice";self.dismiss.isHidden=false}}
 @objc func handle(){state.text="Handled";state.accessibilityIdentifier="handled";dismiss.isHidden=true}
}
